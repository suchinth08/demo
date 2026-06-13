// AgentEye — per-user workspace storage (projects, draft agents, saved conversations,
// migrated client-side stores). Now backed by SQLite (workspace/db.js); this module
// keeps the same public API server.js already calls. Ownership is enforced in db.js
// (every query is scoped by user_id), so there are no filesystem paths to sanitise.

const db = require('./db');

// projects
const listProjects  = (u)        => db.listProjects(u);
const createProject = (u, p)     => db.createProject(u, p || {});
const getProject    = (u, id)    => db.getProject(u, id);
const renameProject = (u, id, p) => db.renameProject(u, id, p || {});
const deleteProject = (u, id)    => db.deleteProject(u, id);

// drafts
const listDrafts  = (u, p)        => db.listItems(u, p, 'drafts');
const getDraft    = (u, p, id)    => db.getItem(u, p, 'drafts', id);
const putDraft    = (u, p, id, d) => db.putItem(u, p, 'drafts', id, d);
const deleteDraft = (u, p, id)    => db.deleteItem(u, p, 'drafts', id);

// conversations
const listConversations  = (u, p)        => db.listItems(u, p, 'conversations');
const getConversation    = (u, p, id)    => db.getItem(u, p, 'conversations', id);
const putConversation    = (u, p, id, d) => db.putItem(u, p, 'conversations', id, d);
const deleteConversation = (u, p, id)    => db.deleteItem(u, p, 'conversations', id);

// per-project stores
const getStores = (u, p)    => db.getStores(u, p);
const putStores = (u, p, s) => db.putStores(u, p, s);

// collaboration / RBAC (S8)
const roleFor       = (u, p)          => db.roleFor(u, p);
const listMembers   = (u, p)          => db.listMembers(u, p);
const addMember     = (u, p, un, r)   => db.addMember(u, p, un, r);
const setMemberRole = (u, p, tu, r)   => db.setMemberRole(u, p, tu, r);
const removeMember  = (u, p, tu)      => db.removeMember(u, p, tu);

module.exports = {
  listProjects, createProject, getProject, renameProject, deleteProject,
  listDrafts, getDraft, putDraft, deleteDraft,
  listConversations, getConversation, putConversation, deleteConversation,
  getStores, putStores,
  roleFor, listMembers, addMember, setMemberRole, removeMember,
  newId: db.newId,
};
