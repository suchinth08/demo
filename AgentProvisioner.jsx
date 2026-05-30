import { useState, useRef, useEffect, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT — Provisioning Wizard
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert AWS Bedrock Agent architect and a warm, friendly provisioning wizard. Your job is to help non-technical business users design and configure a complete, production-ready AWS Bedrock Agent through natural conversation — one clear question at a time.

STAGES (progress in order):
1. USE_CASE — What problem does the agent solve? Who uses it? What outcomes does it drive?
2. PERSONA — Agent name, role title, behavioral personality, tone of voice
3. MODEL — Foundation model selection (default recommendation: Claude 3.5 Sonnet v2 for most cases; Nova Pro for cost-sensitive; Opus for complex reasoning)
4. KNOWLEDGE — Knowledge bases needed: documents, databases, S3 data, product catalogs, FAQs
5. TOOLS — Action groups (things the agent can DO): APIs it calls, systems it writes to, calculations, lookups. Also MCP connectors: Salesforce, Jira, Confluence, Slack, SAP, databases, custom REST APIs
6. GUARDRAILS — Content safety, topic restrictions, PII handling (anonymize vs block), denied topics
7. MEMORY — Session memory (remember within conversation), long-term memory (across sessions), retention period
8. COMPLETE — All configured. Write a detailed, comprehensive instruction prompt for the agent.

RULES:
- Ask ONE focused question at a time, in plain business language (no AWS jargon)
- Translate technical concepts: say "data sources the agent can look up" not "vector knowledge base embeddings"
- Be warm and encouraging: "Great choice!", "That makes perfect sense for your use case."
- Proactively suggest smart defaults: "For a customer support bot, I'd recommend content filtering ON and PII anonymization — shall I set those up?"
- Probe deeply on TOOLS stage: ask if they need to integrate with CRMs, ticketing systems, databases, file systems, external APIs
- At COMPLETE stage, write a rich, detailed multi-paragraph system instruction that captures: agent identity, role, capabilities, constraints, tone, how it should handle edge cases
- Keep responses concise — one short paragraph max, then the question

ALWAYS respond in this EXACT JSON format. No markdown fences, no extra text, just raw valid JSON:
{
  "message": "Your friendly response + next question",
  "stage": "USE_CASE",
  "agentConfig": {
    "name": null,
    "description": null,
    "useCase": null,
    "targetUsers": null,
    "foundationModel": null,
    "instruction": null,
    "knowledgeBases": [],
    "actionGroups": [],
    "mcpConnectors": [],
    "guardrails": null,
    "memory": null
  },
  "readyToGenerate": false
}

Only include fields you've determined — leave undetermined fields as null or [].
Set readyToGenerate: true only when stage is COMPLETE and instruction is fully written.`;

// ─────────────────────────────────────────────────────────────────────────────
// YAML GENERATOR
// ─────────────────────────────────────────────────────────────────────────────
function generateYAML(cfg) {
  if (!cfg || !cfg.name) return `# Your CloudFormation YAML will appear here\n# as you provision your agent through the conversation.`;

  const stackId = cfg.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const resId   = cfg.name.replace(/[^a-zA-Z0-9]/g, '');
  const model   = cfg.foundationModel || 'anthropic.claude-3-5-sonnet-20241022-v2:0';
  const instr   = (cfg.instruction || 'You are a helpful AI assistant.').split('\n').map(l => `        ${l}`).join('\n');

  let y = `# ════════════════════════════════════════════════════════════
# AWS Bedrock Agent · CloudFormation Template
# Agent : ${cfg.name}
# Model : ${model}
#
# Deploy
#   aws cloudformation deploy \\
#     --template-file agent.yaml \\
#     --stack-name ${stackId}-stack \\
#     --capabilities CAPABILITY_IAM \\
#     --parameter-overrides AgentRoleArn=arn:aws:iam::ACCOUNT_ID:role/ROLE_NAME
# ════════════════════════════════════════════════════════════

AWSTemplateFormatVersion: '2010-09-09'
Description: 'Bedrock Agent: ${cfg.description || cfg.useCase || cfg.name}'

Parameters:
  AgentRoleArn:
    Type: String
    Description: IAM Role ARN — needs bedrock:* and lambda:InvokeFunction
  Environment:
    Type: String
    Default: production
    AllowedValues: [development, staging, production]

Resources:

  # ── Agent ───────────────────────────────────────────────────────────────────
  ${resId}Agent:
    Type: AWS::Bedrock::Agent
    Properties:
      AgentName: !Sub '\${Environment}-${resId}'
      Description: >-
        ${cfg.description || cfg.useCase || 'AI-powered agent'}
      Instruction: |
${instr}
      FoundationModel: ${model}
      IdleSessionTTLInSeconds: 1800
      AgentResourceRoleArn: !Ref AgentRoleArn
      AutoPrepare: true
`;

  if (cfg.knowledgeBases?.length) {
    y += `      KnowledgeBases:\n`;
    cfg.knowledgeBases.forEach(kb => {
      const kbId = kb.name.replace(/[^a-zA-Z0-9]/g, '');
      y += `        - KnowledgeBaseId: !Ref KB${kbId}\n          Description: ${kb.description || kb.name}\n          KnowledgeBaseState: ENABLED\n`;
    });
  }

  if (cfg.actionGroups?.length) {
    y += `      ActionGroups:\n`;
    cfg.actionGroups.forEach(ag => {
      const agId = ag.name.replace(/[^a-zA-Z0-9]/g, '');
      y += `        - ActionGroupName: ${agId}\n          Description: ${ag.description || ag.name}\n          ActionGroupState: ENABLED\n          ActionGroupExecutor:\n            Lambda: !GetAtt ${agId}Function.Arn\n          FunctionSchema:\n            Functions:\n              - Name: execute_${agId.toLowerCase()}\n                Description: ${ag.description || ag.name}\n`;
    });
  }

  if (cfg.guardrails) {
    y += `      GuardrailConfiguration:\n        GuardrailIdentifier: !Ref ${resId}Guardrail\n        GuardrailVersion: DRAFT\n`;
  }

  if (cfg.memory?.sessionSummary) {
    y += `      MemoryConfiguration:\n        EnabledMemoryTypes:\n          - SESSION_SUMMARY\n        StorageDays: ${cfg.memory.storageDays || 30}\n`;
  }

  y += `\n  # ── Agent Alias ─────────────────────────────────────────────────────────────\n  ${resId}AgentAlias:\n    Type: AWS::Bedrock::AgentAlias\n    DependsOn: ${resId}Agent\n    Properties:\n      AgentId: !GetAtt ${resId}Agent.AgentId\n      AgentAliasName: !Sub '\${Environment}-alias'\n      Description: !Sub 'Alias — \${Environment}'\n`;

  if (cfg.knowledgeBases?.length) {
    y += `\n  # ── Knowledge Bases ─────────────────────────────────────────────────────────\n`;
    cfg.knowledgeBases.forEach(kb => {
      const kbId = kb.name.replace(/[^a-zA-Z0-9]/g, '');
      y += `  KB${kbId}:\n    Type: AWS::Bedrock::KnowledgeBase\n    Properties:\n      Name: !Sub '\${Environment}-${kb.name.toLowerCase().replace(/\s+/g,'-')}'\n      Description: ${kb.description || kb.name}\n      RoleArn: !Ref AgentRoleArn\n      KnowledgeBaseConfiguration:\n        Type: VECTOR\n        VectorKnowledgeBaseConfiguration:\n          EmbeddingModelArn: arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0\n      StorageConfiguration:\n        Type: OPENSEARCH_SERVERLESS\n        OpensearchServerlessConfiguration:\n          CollectionArn: !GetAtt ${kbId}Collection.Arn\n          VectorIndexName: bedrock-kb-default-index\n          FieldMapping:\n            VectorField: embedding\n            TextField: text\n            MetadataField: metadata\n\n  ${kbId}Collection:\n    Type: AWS::OpenSearchServerless::Collection\n    Properties:\n      Name: !Sub '\${Environment}-${kbId.toLowerCase()}-col'\n      Type: VECTORSEARCH\n      Description: ${kb.description || kb.name}\n\n`;
    });
  }

  if (cfg.guardrails) {
    y += `  # ── Guardrails ───────────────────────────────────────────────────────────────\n  ${resId}Guardrail:\n    Type: AWS::Bedrock::Guardrail\n    Properties:\n      Name: !Sub '\${Environment}-${resId.toLowerCase()}-guardrail'\n      BlockedInputMessaging: "I cannot process that type of request."\n      BlockedOutputsMessaging: "I cannot provide that information."\n`;
    if (cfg.guardrails.contentFiltering) {
      y += `      ContentPolicyConfig:\n        FiltersConfig:\n          - { Type: VIOLENCE,    InputStrength: HIGH, OutputStrength: HIGH }\n          - { Type: HATE,        InputStrength: HIGH, OutputStrength: HIGH }\n          - { Type: SEXUAL,      InputStrength: HIGH, OutputStrength: HIGH }\n          - { Type: MISCONDUCT,  InputStrength: HIGH, OutputStrength: HIGH }\n          - { Type: PROMPT_ATTACK, InputStrength: HIGH, OutputStrength: NONE }\n`;
    }
    if (cfg.guardrails.piiHandling && cfg.guardrails.piiHandling !== 'NONE') {
      y += `      SensitiveInformationPolicyConfig:\n        PiiEntitiesConfig:\n          - { Type: EMAIL,       Action: ${cfg.guardrails.piiHandling} }\n          - { Type: PHONE,       Action: ${cfg.guardrails.piiHandling} }\n          - { Type: NAME,        Action: ${cfg.guardrails.piiHandling} }\n          - { Type: SSN,         Action: ${cfg.guardrails.piiHandling} }\n          - { Type: CREDIT_DEBIT_CARD_NUMBER, Action: ${cfg.guardrails.piiHandling} }\n`;
    }
    if (cfg.guardrails.topics?.length) {
      y += `      TopicPolicyConfig:\n        TopicsConfig:\n`;
      cfg.guardrails.topics.forEach(t => {
        y += `          - Name: "Deny${t.replace(/\s+/g,'')}" \n            Definition: "${t}"\n            Type: DENY\n`;
      });
    }
    y += `\n`;
  }

  if (cfg.actionGroups?.length) {
    y += `  # ── Lambda Stubs (Action Group Executors) ───────────────────────────────────\n  # Replace ZipFile code with your actual Lambda implementation\n`;
    cfg.actionGroups.forEach(ag => {
      const agId = ag.name.replace(/[^a-zA-Z0-9]/g, '');
      y += `  ${agId}Function:\n    Type: AWS::Lambda::Function\n    Properties:\n      FunctionName: !Sub '\${Environment}-${agId.toLowerCase()}'\n      Description: ${ag.description || ag.name}\n      Runtime: python3.12\n      Handler: index.handler\n      Role: !Ref AgentRoleArn\n      Timeout: 30\n      Code:\n        ZipFile: |\n          import json\n          def handler(event, context):\n              # TODO: Implement ${ag.description || ag.name}\n              return {"response": {"actionGroup": event.get("actionGroup"), "function": event.get("function"), "functionResponse": {"responseBody": {"TEXT": {"body": "Success"}}}}}\n\n`;
    });
  }

  if (cfg.mcpConnectors?.length) {
    y += `  # ── MCP Connectors (AWS Bedrock AgentCore) ──────────────────────────────────\n  # Run AFTER CloudFormation deploy. AgentCore MCP support requires preview access.\n  #\n`;
    cfg.mcpConnectors.forEach(mc => {
      const mcId = mc.name.toLowerCase().replace(/\s+/g, '-');
      y += `  # ┌─ ${mc.name} (${mc.type}) ──────────\n  # │ ${mc.description || ''}\n  # │\n  # │ aws bedrock-agentcore create-mcp-connector \\\n  # │   --agent-id $(aws cloudformation describe-stacks --stack-name ${stackId}-stack \\\n  # │               --query 'Stacks[0].Outputs[?OutputKey==\`AgentId\`].OutputValue' \\\n  # │               --output text) \\\n  # │   --connector-name ${mcId} \\\n  # │   --connector-configuration '{"type":"${mc.type.toUpperCase()}","endpoint":"<YOUR_ENDPOINT>"}'\n  # └────────────────────────────────────────────────────────────\n  #\n`;
    });
    y += `\n`;
  }

  y += `Outputs:\n  AgentId:\n    Description: Bedrock Agent ID\n    Value: !GetAtt ${resId}Agent.AgentId\n    Export:\n      Name: !Sub '\${AWS::StackName}-AgentId'\n\n  AgentAliasId:\n    Description: Alias ID — use this for runtime invoke-agent calls\n    Value: !GetAtt ${resId}AgentAlias.AgentAliasId\n    Export:\n      Name: !Sub '\${AWS::StackName}-AliasId'\n\n  SampleInvokeCommand:\n    Description: Test your agent from CLI after deploy\n    Value: !Sub |\n      aws bedrock-agent-runtime invoke-agent \\\n        --agent-id \${${resId}Agent.AgentId} \\\n        --agent-alias-id \${${resId}AgentAlias.AgentAliasId} \\\n        --session-id "test-session-001" \\\n        --input-text "Hello, what can you help me with?" \\\n        output.json && cat output.json\n`;

  return y;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function parseAI(text) {
  try {
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return { message: text, stage: null, agentConfig: {}, readyToGenerate: false };
  }
}

function mergeConfig(prev, next) {
  if (!next) return prev;
  const out = { ...prev };
  Object.entries(next).forEach(([k, v]) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) { if (v.length > 0) out[k] = v; }
    else if (typeof v === 'object') { out[k] = { ...(prev[k] || {}), ...v }; }
    else { out[k] = v; }
  });
  return out;
}

const STAGE_LIST = ["USE_CASE","PERSONA","MODEL","KNOWLEDGE","TOOLS","GUARDRAILS","MEMORY","COMPLETE"];
const STAGE_LABELS = ["Use Case","Persona","Model","Knowledge","Tools","Guardrails","Memory","Ready"];
const STAGE_ICONS  = ["💡","🤖","🧠","📚","⚙️","🛡️","💾","✅"];

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
function StageRail({ current }) {
  const idx = STAGE_LIST.indexOf(current);
  return (
    <div style={{ display:"flex", alignItems:"center", padding:"0 8px", gap:0 }}>
      {STAGE_LIST.map((s, i) => {
        const done   = i < idx;
        const active = i === idx;
        return (
          <div key={s} style={{ display:"flex", alignItems:"center", flex: i < STAGE_LIST.length-1 ? 1 : "none" }}>
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:3, flexShrink:0 }}>
              <div style={{
                width:22, height:22, borderRadius:"50%",
                background: done ? "#FF9900" : active ? "rgba(255,153,0,0.15)" : "rgba(255,255,255,0.05)",
                border: `1.5px solid ${done ? "#FF9900" : active ? "#FF9900" : "rgba(255,255,255,0.1)"}`,
                display:"flex", alignItems:"center", justifyContent:"center",
                fontSize:9, color: done ? "#000" : active ? "#FF9900" : "#374151",
                fontWeight:700, transition:"all 0.3s",
                boxShadow: active ? "0 0 10px rgba(255,153,0,0.5)" : "none",
              }}>
                {done ? "✓" : i+1}
              </div>
              <span style={{
                fontSize:8, letterSpacing:"0.07em", textTransform:"uppercase",
                color: active ? "#FF9900" : done ? "#6B7280" : "#374151",
                fontFamily:"'IBM Plex Mono',monospace", whiteSpace:"nowrap",
              }}>{STAGE_LABELS[i]}</span>
            </div>
            {i < STAGE_LIST.length-1 && (
              <div style={{
                flex:1, height:1.5, margin:"0 3px", marginBottom:14,
                background: done ? "#FF9900" : "rgba(255,255,255,0.06)",
                transition:"background 0.4s",
              }}/>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Dot({ color, pulse }) {
  return (
    <span style={{
      display:"inline-block", width:6, height:6, borderRadius:"50%",
      background:color, boxShadow:`0 0 6px ${color}`,
      animation: pulse ? "agPulse 1.4s infinite" : "none",
      flexShrink:0,
    }}/>
  );
}

function Badge({ color, label }) {
  return (
    <span style={{
      padding:"2px 8px", borderRadius:10, fontSize:9,
      background:`${color}18`, border:`1px solid ${color}44`,
      color:color, fontFamily:"'IBM Plex Mono',monospace",
      letterSpacing:"0.06em", textTransform:"uppercase",
    }}>{label}</span>
  );
}

function ConfigPanel({ cfg }) {
  if (!cfg?.name && !cfg?.useCase) return (
    <div style={{ padding:32, textAlign:"center", color:"#2D3748" }}>
      <div style={{ fontSize:36, marginBottom:12 }}>🤖</div>
      <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, lineHeight:1.8 }}>
        Agent config builds live<br/>as you answer questions
      </div>
    </div>
  );

  const cards = [
    { key:"name",           label:"Agent Name",       icon:"🤖", color:"#FF9900",  val: cfg.name },
    { key:"foundationModel",label:"Foundation Model",  icon:"🧠", color:"#818CF8",  val: cfg.foundationModel?.replace('anthropic.','').replace(':0','') },
    { key:"useCase",        label:"Use Case",          icon:"💡", color:"#FBBF24",  val: cfg.useCase },
    { key:"targetUsers",    label:"Target Users",      icon:"👥", color:"#34D399",  val: cfg.targetUsers },
    { key:"instruction",    label:"Agent Instruction", icon:"📋", color:"#60A5FA",  val: cfg.instruction?.slice(0,200) + (cfg.instruction?.length > 200 ? "…" : "") },
  ].filter(c => c.val);

  return (
    <div style={{ padding:"14px 14px", display:"flex", flexDirection:"column", gap:10 }}>
      {cards.map(c => (
        <div key={c.key} style={{
          padding:"10px 12px", borderRadius:8,
          background:`${c.color}08`, border:`1px solid ${c.color}22`,
        }}>
          <div style={{ fontSize:9, color:c.color, fontFamily:"'IBM Plex Mono',monospace", letterSpacing:"0.09em", textTransform:"uppercase", marginBottom:4 }}>
            {c.icon}  {c.label}
          </div>
          <div style={{ fontSize:11.5, color:"#CBD5E1", fontFamily:"'IBM Plex Mono',monospace", lineHeight:1.6 }}>{c.val}</div>
        </div>
      ))}

      {cfg.knowledgeBases?.length > 0 && (
        <div style={{ padding:"10px 12px", borderRadius:8, background:"#00D4AA08", border:"1px solid #00D4AA22" }}>
          <div style={{ fontSize:9, color:"#00D4AA", fontFamily:"'IBM Plex Mono',monospace", letterSpacing:"0.09em", textTransform:"uppercase", marginBottom:6 }}>📚  Knowledge Bases ({cfg.knowledgeBases.length})</div>
          {cfg.knowledgeBases.map((kb,i) => <div key={i} style={{ fontSize:11, color:"#9CA3AF", fontFamily:"'IBM Plex Mono',monospace", marginBottom:2 }}>· {kb.name} — {kb.source || 'vector'}</div>)}
        </div>
      )}

      {cfg.actionGroups?.length > 0 && (
        <div style={{ padding:"10px 12px", borderRadius:8, background:"#818CF808", border:"1px solid #818CF822" }}>
          <div style={{ fontSize:9, color:"#818CF8", fontFamily:"'IBM Plex Mono',monospace", letterSpacing:"0.09em", textTransform:"uppercase", marginBottom:6 }}>⚙️  Action Groups ({cfg.actionGroups.length})</div>
          {cfg.actionGroups.map((ag,i) => <div key={i} style={{ fontSize:11, color:"#9CA3AF", fontFamily:"'IBM Plex Mono',monospace", marginBottom:2 }}>· {ag.name}</div>)}
        </div>
      )}

      {cfg.mcpConnectors?.length > 0 && (
        <div style={{ padding:"10px 12px", borderRadius:8, background:"#FBBF2408", border:"1px solid #FBBF2422" }}>
          <div style={{ fontSize:9, color:"#FBBF24", fontFamily:"'IBM Plex Mono',monospace", letterSpacing:"0.09em", textTransform:"uppercase", marginBottom:6 }}>🔌  MCP Connectors ({cfg.mcpConnectors.length})</div>
          {cfg.mcpConnectors.map((mc,i) => <div key={i} style={{ fontSize:11, color:"#9CA3AF", fontFamily:"'IBM Plex Mono',monospace", marginBottom:2 }}>· {mc.name} <span style={{color:"#4B5563"}}>({mc.type})</span></div>)}
        </div>
      )}

      {cfg.guardrails && (
        <div style={{ padding:"10px 12px", borderRadius:8, background:"#F8717108", border:"1px solid #F8717122" }}>
          <div style={{ fontSize:9, color:"#F87171", fontFamily:"'IBM Plex Mono',monospace", letterSpacing:"0.09em", textTransform:"uppercase", marginBottom:4 }}>🛡️  Guardrails</div>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
            {cfg.guardrails.contentFiltering && <Badge color="#F87171" label="Content Filter ON"/>}
            {cfg.guardrails.piiHandling && cfg.guardrails.piiHandling !== "NONE" && <Badge color="#F87171" label={`PII: ${cfg.guardrails.piiHandling}`}/>}
            {cfg.guardrails.topics?.map((t,i) => <Badge key={i} color="#F87171" label={`Block: ${t}`}/>)}
          </div>
        </div>
      )}

      {cfg.memory && (
        <div style={{ padding:"10px 12px", borderRadius:8, background:"#34D39908", border:"1px solid #34D39922" }}>
          <div style={{ fontSize:9, color:"#34D399", fontFamily:"'IBM Plex Mono',monospace", letterSpacing:"0.09em", textTransform:"uppercase", marginBottom:4 }}>💾  Memory</div>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
            {cfg.memory.sessionSummary && <Badge color="#34D399" label="Session Summary"/>}
            {cfg.memory.storageDays && <Badge color="#34D399" label={`${cfg.memory.storageDays}d Retention`}/>}
          </div>
        </div>
      )}
    </div>
  );
}

function YamlPanel({ yaml }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(yaml);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
      <div style={{
        padding:"7px 14px", flexShrink:0,
        background:"rgba(255,153,0,0.06)", borderBottom:"1px solid rgba(255,153,0,0.12)",
        display:"flex", alignItems:"center", justifyContent:"space-between",
      }}>
        <span style={{ fontSize:9, color:"#FF9900", fontFamily:"'IBM Plex Mono',monospace", letterSpacing:"0.1em" }}>
          CLOUDFORMATION YAML
        </span>
        <button onClick={copy} style={{
          padding:"3px 10px", borderRadius:4, border:"1px solid rgba(255,153,0,0.3)",
          background:"rgba(255,153,0,0.1)", color: copied ? "#34D399" : "#FF9900",
          fontSize:9, cursor:"pointer", fontFamily:"'IBM Plex Mono',monospace", letterSpacing:"0.06em",
          transition:"color 0.2s",
        }}>{copied ? "✓ COPIED" : "COPY"}</button>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"14px" }}>
        <pre style={{ margin:0, fontFamily:"'IBM Plex Mono',monospace", fontSize:10.5, lineHeight:1.75, whiteSpace:"pre-wrap", wordBreak:"break-word" }}>
          {yaml.split('\n').map((line, i) => {
            let c = "#6B7280";
            if (line.startsWith('#'))                                    c = "#374151";
            if (line.match(/^(AWSTemplate|Description|Parameters|Resources|Outputs):/)) c = "#FF9900";
            if (line.match(/^\s{2}[A-Z][a-zA-Z0-9]+:/) && !line.includes('  #')) c = "#F0A500";
            if (line.match(/^\s{4,}Type:/))                             c = "#FF9900";
            if (line.includes('AWS::'))                                  c = "#00D4AA";
            if (line.includes('!Ref') || line.includes('!GetAtt') || line.includes('!Sub')) c = "#FBBF24";
            if (line.match(/^\s{4,}[A-Za-z][a-zA-Z]+:/) && !line.includes('AWS::')) c = "#94A3B8";
            return <span key={i} style={{ color:c, display:"block" }}>{line}</span>;
          })}
        </pre>
      </div>
    </div>
  );
}

function TestPanel({ cfg }) {
  const [msgs, setMsgs] = useState([]);
  const [inp, setInp]   = useState("");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef(null);
  const histRef   = useRef([]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:"smooth" }); }, [msgs]);

  async function send() {
    const text = inp.trim();
    if (!text || busy) return;
    setInp("");
    const userMsg = { role:"user", content:text };
    setMsgs(p => [...p, userMsg]);
    histRef.current.push(userMsg);
    setBusy(true);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({
          model:"claude-sonnet-4-20250514",
          max_tokens:800,
          system: (cfg.instruction || "You are a helpful assistant.") +
            "\n\n[PREVIEW MODE: Respond as this agent would. Knowledge bases and action groups are simulated.]",
          messages: histRef.current.map(m => ({ role:m.role, content:m.content })),
        }),
      });
      const data = await res.json();
      const reply = data.content?.[0]?.text || "No response.";
      const asstMsg = { role:"assistant", content:reply };
      setMsgs(p => [...p, asstMsg]);
      histRef.current.push(asstMsg);
    } catch {
      setMsgs(p => [...p, { role:"assistant", content:"Error reaching agent preview." }]);
    } finally { setBusy(false); }
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
      <div style={{
        padding:"7px 14px", flexShrink:0,
        background:"rgba(0,212,170,0.06)", borderBottom:"1px solid rgba(0,212,170,0.12)",
        display:"flex", alignItems:"center", gap:8,
      }}>
        <Dot color="#00D4AA" pulse/>
        <span style={{ fontSize:9, color:"#00D4AA", fontFamily:"'IBM Plex Mono',monospace", letterSpacing:"0.1em" }}>
          AGENT PREVIEW — {cfg.name || "Agent"} · Simulated
        </span>
      </div>

      <div style={{ flex:1, overflowY:"auto", padding:"14px 14px 8px" }}>
        {msgs.length === 0 && (
          <div style={{ textAlign:"center", color:"#2D3748", marginTop:48 }}>
            <div style={{ fontSize:30, marginBottom:10 }}>▶</div>
            <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, lineHeight:1.9 }}>
              Chat with your configured agent.<br/>
              <span style={{ color:"#374151", fontSize:10 }}>Knowledge bases & tools are simulated.</span>
            </div>
          </div>
        )}
        {msgs.map((m,i) => (
          <div key={i} style={{
            display:"flex", flexDirection:"column",
            alignItems: m.role==="user" ? "flex-end" : "flex-start",
            marginBottom:12, animation:"agFadeUp 0.2s ease",
          }}>
            <div style={{
              maxWidth:"88%", padding:"8px 12px", fontSize:12, lineHeight:1.65,
              borderRadius: m.role==="user" ? "12px 12px 3px 12px" : "3px 12px 12px 12px",
              background: m.role==="user" ? "rgba(0,212,170,0.12)" : "rgba(255,255,255,0.04)",
              border:`1px solid ${m.role==="user" ? "rgba(0,212,170,0.3)" : "rgba(255,255,255,0.07)"}`,
              color: m.role==="user" ? "#5EEAD4" : "#CBD5E1",
              whiteSpace:"pre-wrap",
            }}>{m.content}</div>
          </div>
        ))}
        {busy && (
          <div style={{ display:"flex", gap:5, padding:"8px 4px" }}>
            {[0,1,2].map(i => <div key={i} style={{ width:5, height:5, borderRadius:"50%", background:"#00D4AA", animation:`agPulse 1.2s infinite ${i*0.2}s` }}/>)}
          </div>
        )}
        <div ref={bottomRef}/>
      </div>

      <div style={{ padding:"10px 12px 14px", borderTop:"1px solid rgba(255,255,255,0.05)", flexShrink:0 }}>
        <div style={{
          display:"flex", gap:8, alignItems:"center",
          background:"rgba(0,212,170,0.06)", border:"1px solid rgba(0,212,170,0.2)", borderRadius:8, padding:"7px 10px",
        }}>
          <input
            value={inp} onChange={e => setInp(e.target.value)}
            onKeyDown={e => { if(e.key==="Enter") send(); }}
            placeholder={`Talk to ${cfg.name || "your agent"}…`}
            style={{ flex:1, background:"transparent", border:"none", color:"#E2E8F0", fontSize:12, fontFamily:"'DM Sans',sans-serif" }}
          />
          <button onClick={send} disabled={busy || !inp.trim()} style={{
            padding:"4px 12px", background:"#00D4AA", border:"none", borderRadius:5,
            fontSize:11, fontWeight:600, color:"#000", cursor:"pointer",
            opacity: busy || !inp.trim() ? 0.35 : 1, transition:"opacity 0.2s",
          }}>▶ Send</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function AgentProvisioner() {
  const [messages, setMessages]   = useState([]);
  const [input, setInput]         = useState("");
  const [loading, setLoading]     = useState(false);
  const [stage, setStage]         = useState("USE_CASE");
  const [agentCfg, setAgentCfg]   = useState({});
  const [rightTab, setRightTab]   = useState("overview");
  const histRef     = useRef([]);
  const chatBottom  = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => { chatBottom.current?.scrollIntoView({ behavior:"smooth" }); }, [messages, loading]);

  useEffect(() => { initConversation(); }, []);

  async function callClaude(history) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1200,
        system: SYSTEM_PROMPT,
        messages: history,
      }),
    });
    const data = await res.json();
    return data.content?.[0]?.text || "";
  }

  async function initConversation() {
    setLoading(true);
    const seed = [{ role:"user", content:"Hi, I want to build an AI agent for my business." }];
    histRef.current = seed;
    try {
      const raw    = await callClaude(seed);
      const parsed = parseAI(raw);
      histRef.current.push({ role:"assistant", content:raw });
      setMessages([{ role:"assistant", content: parsed.message || raw }]);
      if (parsed.stage) setStage(parsed.stage);
    } catch {
      setMessages([{ role:"assistant", content:"👋 Hello! I'm your AWS Bedrock Agent provisioner. I'll guide you step by step — no technical knowledge needed. To start: what business problem do you want your agent to solve?" }]);
    } finally { setLoading(false); }
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    if (textareaRef.current) { textareaRef.current.style.height = "auto"; }

    const userMsg = { role:"user", content:text };
    setMessages(p => [...p, { role:"user", content:text }]);
    histRef.current.push(userMsg);
    setLoading(true);

    try {
      const raw    = await callClaude(histRef.current);
      const parsed = parseAI(raw);
      histRef.current.push({ role:"assistant", content:raw });
      setMessages(p => [...p, { role:"assistant", content: parsed.message || raw }]);
      if (parsed.stage) setStage(parsed.stage);
      if (parsed.agentConfig) setAgentCfg(p => mergeConfig(p, parsed.agentConfig));
      if (parsed.readyToGenerate) setRightTab("yaml");
    } catch (e) {
      setMessages(p => [...p, { role:"assistant", content:"Something went wrong — please try again." }]);
    } finally { setLoading(false); }
  }

  const isComplete = stage === "COMPLETE";
  const yaml       = generateYAML(agentCfg);

  return (
    <div style={{ height:"100vh", display:"flex", flexDirection:"column", background:"#090B12", color:"#E2E8F0", fontFamily:"'DM Sans','Segoe UI',sans-serif", overflow:"hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=IBM+Plex+Mono:wght@300;400;500&family=Syne:wght@600;700;800&display=swap');
        *{box-sizing:border-box;}
        ::-webkit-scrollbar{width:3px;height:3px;}
        ::-webkit-scrollbar-track{background:transparent;}
        ::-webkit-scrollbar-thumb{background:rgba(255,153,0,0.25);border-radius:2px;}
        textarea:focus,input:focus{outline:none;}
        @keyframes agFadeUp{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}
        @keyframes agPulse{0%,100%{opacity:.3;transform:scale(.8);}50%{opacity:1;transform:scale(1.2);}}
        @keyframes agSpin{to{transform:rotate(360deg);}}
      `}</style>

      {/* ── HEADER ── */}
      <div style={{ padding:"10px 22px", borderBottom:"1px solid rgba(255,153,0,0.1)", background:"rgba(9,11,18,0.98)", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0, backdropFilter:"blur(10px)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <div style={{ width:32, height:32, borderRadius:8, background:"linear-gradient(135deg,#FF9900,#E07800)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:17, boxShadow:"0 0 20px rgba(255,153,0,0.35)" }}>⚡</div>
          <div>
            <div style={{ fontFamily:"'Syne',sans-serif", fontWeight:800, fontSize:15, color:"#F9FAFB", letterSpacing:"-0.03em" }}>Agent Provisioner</div>
            <div style={{ fontSize:9, color:"#4B5563", fontFamily:"'IBM Plex Mono',monospace", letterSpacing:"0.07em", textTransform:"uppercase" }}>AWS Bedrock AgentCore · Conversational Setup</div>
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          {agentCfg.name && (
            <div style={{ padding:"4px 12px", borderRadius:16, background:"rgba(255,153,0,0.08)", border:"1px solid rgba(255,153,0,0.25)", fontSize:11, color:"#FF9900", fontFamily:"'IBM Plex Mono',monospace", display:"flex", alignItems:"center", gap:7 }}>
              <Dot color="#FF9900" pulse={!isComplete}/>{agentCfg.name}
              {isComplete && <span style={{ marginLeft:4, fontSize:10 }}>✅</span>}
            </div>
          )}
        </div>
      </div>

      {/* ── STAGE RAIL ── */}
      <div style={{ padding:"10px 28px", borderBottom:"1px solid rgba(255,255,255,0.04)", background:"rgba(9,11,18,0.7)", flexShrink:0 }}>
        <StageRail current={stage}/>
      </div>

      {/* ── BODY ── */}
      <div style={{ flex:1, display:"flex", overflow:"hidden" }}>

        {/* LEFT: Chat */}
        <div style={{ width:"50%", display:"flex", flexDirection:"column", borderRight:"1px solid rgba(255,153,0,0.08)" }}>
          <div style={{ flex:1, overflowY:"auto", padding:"18px 18px 6px" }}>
            {messages.map((m, i) => (
              <div key={i} style={{ display:"flex", flexDirection:"column", alignItems: m.role==="user" ? "flex-end" : "flex-start", marginBottom:14, animation:"agFadeUp 0.22s ease" }}>
                <div style={{ fontSize:8.5, color:"#374151", fontFamily:"'IBM Plex Mono',monospace", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:3 }}>
                  {m.role==="user" ? "YOU" : `PROVISIONER  ·  ${STAGE_ICONS[STAGE_LIST.indexOf(stage)]}  ${STAGE_LABELS[STAGE_LIST.indexOf(stage)]}`}
                </div>
                <div style={{
                  maxWidth:"90%", padding:"10px 14px",
                  borderRadius: m.role==="user" ? "14px 14px 4px 14px" : "4px 14px 14px 14px",
                  background: m.role==="user" ? "linear-gradient(135deg,#FF9900,#E07800)" : "rgba(255,255,255,0.04)",
                  border: m.role==="user" ? "none" : "1px solid rgba(255,255,255,0.07)",
                  color: m.role==="user" ? "#000" : "#C9D3E0",
                  fontSize:13, lineHeight:1.7,
                  boxShadow: m.role==="user" ? "0 3px 18px rgba(255,153,0,0.22)" : "none",
                  fontWeight: m.role==="user" ? 500 : 400,
                  whiteSpace:"pre-wrap",
                }}>{m.content}</div>
              </div>
            ))}
            {loading && (
              <div style={{ display:"flex", alignItems:"flex-start", marginBottom:14 }}>
                <div style={{ padding:"10px 14px", background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:"4px 14px 14px 14px", display:"flex", gap:5, alignItems:"center" }}>
                  {[0,1,2].map(i=><div key={i} style={{ width:6, height:6, borderRadius:"50%", background:"#FF9900", animation:`agPulse 1.2s infinite ${i*0.2}s` }}/>)}
                </div>
              </div>
            )}
            <div ref={chatBottom}/>
          </div>

          {/* Input bar */}
          <div style={{ padding:"10px 14px 14px", borderTop:"1px solid rgba(255,255,255,0.05)", flexShrink:0 }}>
            <div style={{ display:"flex", gap:8, alignItems:"flex-end", background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,153,0,0.18)", borderRadius:10, padding:"8px 10px" }}>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); sendMessage(); }}}
                placeholder={loading ? "Thinking…" : "Describe your use case or answer the question…"}
                disabled={loading}
                rows={1}
                style={{ flex:1, background:"transparent", border:"none", color:"#E2E8F0", fontSize:13, fontFamily:"'DM Sans',sans-serif", resize:"none", maxHeight:100, overflowY:"auto", lineHeight:1.55 }}
                onInput={e => { e.target.style.height="auto"; e.target.style.height=Math.min(e.target.scrollHeight,100)+"px"; }}
              />
              <button onClick={sendMessage} disabled={loading || !input.trim()} style={{
                width:32, height:32, borderRadius:7, border:"none",
                background: loading || !input.trim() ? "rgba(255,255,255,0.05)" : "#FF9900",
                color: loading || !input.trim() ? "#374151" : "#000",
                cursor: loading || !input.trim() ? "not-allowed" : "pointer",
                fontSize:16, fontWeight:700, flexShrink:0, transition:"all 0.2s",
                boxShadow: (!loading && input.trim()) ? "0 0 14px rgba(255,153,0,0.45)" : "none",
              }}>↑</button>
            </div>
            <div style={{ marginTop:6, fontSize:9, color:"#2D3748", textAlign:"center", fontFamily:"'IBM Plex Mono',monospace", letterSpacing:"0.05em" }}>
              Enter · Send  ·  Shift+Enter · Newline  ·  Context retained across all turns
            </div>
          </div>
        </div>

        {/* RIGHT: Panels */}
        <div style={{ width:"50%", display:"flex", flexDirection:"column" }}>
          {/* Tab bar */}
          <div style={{ display:"flex", borderBottom:"1px solid rgba(255,255,255,0.05)", background:"rgba(9,11,18,0.8)", flexShrink:0 }}>
            {[
              { id:"overview", label:"Agent Overview",    icon:"🤖" },
              { id:"yaml",     label:"CloudFormation",    icon:"📄" },
              { id:"test",     label:"Test Agent",        icon:"▶", locked:!isComplete },
            ].map(t => (
              <button key={t.id} onClick={() => !t.locked && setRightTab(t.id)} style={{
                padding:"11px 16px", background:"transparent", border:"none",
                borderBottom: rightTab===t.id ? "2px solid #FF9900" : "2px solid transparent",
                color: rightTab===t.id ? "#FF9900" : t.locked ? "#1F2937" : "#6B7280",
                fontSize:11, fontFamily:"'IBM Plex Mono',monospace", cursor: t.locked ? "not-allowed" : "pointer",
                display:"flex", alignItems:"center", gap:6, letterSpacing:"0.04em",
                transition:"color 0.2s",
              }}>
                {t.icon} {t.label}
                {t.locked && <span style={{ fontSize:8, color:"#1F2937", marginLeft:2 }}>🔒</span>}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div style={{ flex:1, overflowY:"auto" }}>
            {rightTab==="overview" && <ConfigPanel cfg={agentCfg}/>}
            {rightTab==="yaml"     && <YamlPanel yaml={yaml}/>}
            {rightTab==="test"     && isComplete && <TestPanel cfg={agentCfg}/>}
            {rightTab==="test"     && !isComplete && (
              <div style={{ padding:32, textAlign:"center", color:"#2D3748" }}>
                <div style={{ fontSize:28, marginBottom:10 }}>🔒</div>
                <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11 }}>Complete provisioning to<br/>unlock agent preview</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
