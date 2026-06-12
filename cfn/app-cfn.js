// cfn/app-cfn.js
// Deterministic compiler: SolutionSpec → app-tier CloudFormation (frontend on
// S3 + CloudFront, BFF on Lambda). No model call. The agent coordinates
// (AgentId / AgentAliasId / AgentAliasArn) arrive as PARAMETERS and are threaded
// into the BFF's environment + IAM — this is the app→agent fusion surface, the
// same params-not-ImportValue pattern proven for agent→agent.
//
// Phase 1: hosting = cloudfront-s3 (frontend) + lambda (BFF). The BFF deployment
// package location arrives as S3 params (CI uploads it). AWS-managed CachePolicy
// / OriginRequestPolicy IDs are used by id. Validate with cfn-lint before deploy.

'use strict';

const yaml = require('js-yaml');

const Ref    = name        => ({ Ref: name });
const GetAtt = (res, attr) => ({ 'Fn::GetAtt': [res, attr] });
const Sub    = tmpl        => ({ 'Fn::Sub': tmpl });

// AWS-managed policy ids (stable, documented).
const CACHE_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6';
const CACHE_DISABLED  = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const ORP_ALLVIEWER_EXCEPT_HOST = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';

function tagList(tags) {
  return Object.entries(tags || {}).filter(([, v]) => v != null && v !== '').map(([Key, Value]) => ({ Key, Value: String(Value) }));
}

function buildAppCfn(solution) {
  const sol = solution || {};
  const app = sol.app || {};
  const ent = app.enterprise || {};
  const tags = ent.tags || {};
  const propagateIdentity = !!(app.identity && app.identity.propagateToAgent);

  const Parameters = {
    // ── app→agent fusion surface (defaults filled by the deploy manifest from the agent stack outputs) ──
    AgentId:       { Type: 'String', Description: 'Bedrock agent id (from the agent stack output).' },
    AgentAliasId:  { Type: 'String', Description: 'Bedrock agent alias id (from the agent stack output).' },
    AgentAliasArn: { Type: 'String', Description: 'Bedrock agent alias ARN — scopes the BFF\'s InvokeAgent permission.' },
    // ── BFF deployment package (CI uploads the zip, passes its location) ──
    BffCodeBucket: { Type: 'String', Description: 'S3 bucket holding the BFF Lambda deployment package.' },
    BffCodeKey:    { Type: 'String', Description: 'S3 key of the BFF Lambda deployment package (.zip).' },
  };

  const Resources = {};

  // ── Frontend: private S3 bucket + CloudFront (OAC) ──
  Resources.FrontendBucket = {
    Type: 'AWS::S3::Bucket',
    Properties: {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
      ...(tagList(tags).length ? { Tags: tagList(tags) } : {}),
    },
  };
  Resources.OriginAccessControl = {
    Type: 'AWS::CloudFront::OriginAccessControl',
    Properties: { OriginAccessControlConfig: { Name: Sub('${AWS::StackName}-oac'), OriginAccessControlOriginType: 's3', SigningBehavior: 'always', SigningProtocol: 'sigv4' } },
  };

  // ── BFF: IAM role + Lambda + Function URL ──
  Resources.BffRole = {
    Type: 'AWS::IAM::Role',
    Properties: {
      AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
      ManagedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
      Policies: [{
        PolicyName: 'InvokeAgent',
        PolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['bedrock:InvokeAgent'], Resource: Ref('AgentAliasArn') }] },
      }],
      ...(tagList(tags).length ? { Tags: tagList(tags) } : {}),
    },
  };
  Resources.BffFunction = {
    Type: 'AWS::Lambda::Function',
    Properties: {
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',                       // see CLAUDE.md: http-server BFF needs a handler/adapter for Lambda
      Role: GetAtt('BffRole', 'Arn'),
      Code: { S3Bucket: Ref('BffCodeBucket'), S3Key: Ref('BffCodeKey') },
      Timeout: 30,
      MemorySize: 512,
      Environment: {
        // AWS_REGION is reserved/auto-provided by Lambda — do not set it here.
        Variables: { AGENT_ID: Ref('AgentId'), AGENT_ALIAS_ID: Ref('AgentAliasId'), PROPAGATE_IDENTITY: propagateIdentity ? 'true' : 'false' },
      },
      ...(tagList(tags).length ? { Tags: tagList(tags) } : {}),
    },
  };
  Resources.BffUrl = {
    Type: 'AWS::Lambda::Url',
    Properties: { TargetFunctionArn: Ref('BffFunction'), AuthType: 'NONE' },   // tighten to AWS_IAM for non-public APIs
  };
  Resources.BffUrlPermission = {
    Type: 'AWS::Lambda::Permission',
    Properties: { FunctionName: Ref('BffFunction'), Action: 'lambda:InvokeFunctionUrl', Principal: '*', FunctionUrlAuthType: 'NONE' },
  };

  // ── CloudFront: S3 default origin + /api/* → BFF function-url origin (single origin = no CORS) ──
  Resources.Distribution = {
    Type: 'AWS::CloudFront::Distribution',
    Properties: {
      DistributionConfig: {
        Enabled: true,
        DefaultRootObject: 'index.html',
        Origins: [
          { Id: 'S3Origin', DomainName: GetAtt('FrontendBucket', 'RegionalDomainName'), OriginAccessControlId: GetAtt('OriginAccessControl', 'Id'), S3OriginConfig: { OriginAccessIdentity: '' } },
          // Function URL is https://<id>.lambda-url.<region>.on.aws/ — take the host (split index 2).
          { Id: 'BffOrigin', DomainName: { 'Fn::Select': [2, { 'Fn::Split': ['/', GetAtt('BffUrl', 'FunctionUrl')] }] }, CustomOriginConfig: { OriginProtocolPolicy: 'https-only', OriginSSLProtocols: ['TLSv1.2'] } },
        ],
        DefaultCacheBehavior: { TargetOriginId: 'S3Origin', ViewerProtocolPolicy: 'redirect-to-https', CachePolicyId: CACHE_OPTIMIZED },
        CacheBehaviors: [
          { PathPattern: '/api/*', TargetOriginId: 'BffOrigin', ViewerProtocolPolicy: 'https-only', AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'], CachePolicyId: CACHE_DISABLED, OriginRequestPolicyId: ORP_ALLVIEWER_EXCEPT_HOST },
        ],
      },
      ...(tagList(tags).length ? { Tags: tagList(tags) } : {}),
    },
  };

  // Bucket policy: only this distribution may read the bucket.
  Resources.FrontendBucketPolicy = {
    Type: 'AWS::S3::BucketPolicy',
    Properties: {
      Bucket: Ref('FrontendBucket'),
      PolicyDocument: { Version: '2012-10-17', Statement: [{
        Effect: 'Allow', Principal: { Service: 'cloudfront.amazonaws.com' }, Action: 's3:GetObject',
        Resource: Sub('${FrontendBucket.Arn}/*'),
        Condition: { StringEquals: { 'AWS:SourceArn': Sub('arn:aws:cloudfront::${AWS::AccountId}:distribution/${Distribution}') } },
      }] },
    },
  };

  const exp = suffix => ({ 'Fn::Sub': '${AWS::StackName}-' + suffix });
  const Outputs = {
    SiteUrl:         { Value: Sub('https://${Distribution.DomainName}'), Export: { Name: exp('SiteUrl') } },
    BffFunctionUrl:  { Value: GetAtt('BffUrl', 'FunctionUrl'),           Export: { Name: exp('BffFunctionUrl') } },
    FrontendBucket:  { Value: Ref('FrontendBucket'),                     Export: { Name: exp('FrontendBucket') } },
  };

  const template = {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `AgentEye-generated app tier for ${sol.name || 'solution'} (dashboard-portal): S3+CloudFront frontend, Lambda BFF.`,
    Metadata: {
      'AgentEye::Provenance': {
        generator: 'app-cfn@0.1',
        solution: `${sol.slug}:${sol.version}`,
        hosting: `${(ent.hosting && ent.hosting.frontend) || 'cloudfront-s3'} + ${(ent.hosting && ent.hosting.bff) || 'lambda'}`,
        note: 'BFF (Node http server) needs a Lambda handler/adapter (e.g. AWS Lambda Web Adapter) — see CLAUDE.md fill task.',
      },
    },
    Parameters,
    Resources,
    Outputs,
  };

  return yaml.dump(template, { lineWidth: -1, noRefs: true, sortKeys: false });
}

module.exports = { buildAppCfn };
