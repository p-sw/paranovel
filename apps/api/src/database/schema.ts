import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  logline: text('logline').notNull(),
  genreTagsJson: text('genre_tags_json').notNull(),
  detailsJson: text('details_json').notNull(),
  defaultTargetChars: integer('default_target_chars').notNull(),
  targetEpisode: integer('target_episode'),
  targetEpisodeSource: text('target_episode_source'),
  nextEpisodeNumber: integer('next_episode_number').notNull(),
  revision: integer('revision').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

export const projectCreationSessions = sqliteTable('project_creation_sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id'),
  logline: text('logline').notNull(),
  genreTagsJson: text('genre_tags_json').notNull(),
  answersJson: text('answers_json').notNull(),
  transcriptJson: text('transcript_json').notNull(),
  pendingQuestionJson: text('pending_question_json'),
  blueprintJson: text('blueprint_json'),
  titleAsked: integer('title_asked').notNull(),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const sideStoryGroups = sqliteTable(
  'side_story_groups',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    branchFromEpisodeId: text('branch_from_episode_id'),
    nextEpisodeNumber: integer('next_episode_number').notNull().default(1),
    revision: integer('revision').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('idx_side_story_groups_project').on(table.projectId, table.createdAt)],
);

export const sideStoryGroupIdempotency = sqliteTable(
  'side_story_group_idempotency',
  {
    projectId: text('project_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    groupId: text('group_id').notNull(),
    requestHash: text('request_hash').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('side_story_group_idempotency_key')
      .on(table.projectId, table.idempotencyKey),
  ],
);

export const episodes = sqliteTable(
  'episodes',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    kind: text('kind').notNull().default('MAIN'),
    number: integer('number'),
    sideStoryGroupId: text('side_story_group_id'),
    branchFromEpisodeId: text('branch_from_episode_id'),
    title: text('title').notNull(),
    direction: text('direction').notNull(),
    content: text('content').notNull(),
    revision: integer('revision').notNull(),
    status: text('status').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    uniqueIndex('episodes_main_project_number')
      .on(table.projectId, table.number)
      .where(sql`${table.kind} = 'MAIN'`),
    uniqueIndex('episodes_side_story_group_number')
      .on(table.sideStoryGroupId, table.number)
      .where(sql`${table.kind} = 'SIDE_STORY' AND ${table.sideStoryGroupId} IS NOT NULL`),
    index('idx_episodes_project_kind').on(table.projectId, table.kind, table.number),
    index('idx_episodes_side_story_group').on(table.sideStoryGroupId, table.number),
  ],
);

export const episodeSummaries = sqliteTable('episode_summaries', {
  episodeId: text('episode_id').primaryKey(),
  synopsis: text('synopsis').notNull(),
  eventsJson: text('events_json').notNull(),
  emotionalChangesJson: text('emotional_changes_json').notNull(),
  foreshadowingIntroducedJson: text('foreshadowing_introduced_json').notNull(),
  foreshadowingResolvedJson: text('foreshadowing_resolved_json').notNull(),
  sourceRevision: integer('source_revision').notNull(),
  sourceHash: text('source_hash').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const episodeIdempotency = sqliteTable(
  'episode_idempotency',
  {
    projectId: text('project_id').notNull(),
    scope: text('scope').notNull().default('MAIN'),
    idempotencyKey: text('idempotency_key').notNull(),
    episodeId: text('episode_id').notNull(),
    requestHash: text('request_hash').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('episode_idempotency_scope_key')
      .on(table.projectId, table.scope, table.idempotencyKey),
  ],
);

export const sceneStates = sqliteTable('scene_states', {
  episodeId: text('episode_id').primaryKey(),
  location: text('location').notNull(),
  storyTime: text('story_time').notNull(),
  pointOfView: text('point_of_view').notNull(),
  characterNamesJson: text('character_names_json').notNull(),
  goal: text('goal').notNull(),
  sourceRevision: integer('source_revision').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const arcs = sqliteTable('arcs', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  sideStoryGroupId: text('side_story_group_id'),
  title: text('title').notNull(),
  startEpisodeNumber: integer('start_episode_number').notNull(),
  endEpisodeNumber: integer('end_episode_number').notNull(),
  goal: text('goal').notNull(),
  conflict: text('conflict').notNull(),
  // Retained for existing databases; arc planning uses reversalPlanJson only.
  twistPlan: text('twist_plan').notNull().default(''),
  reversalPlanJson: text('reversal_plan_json').notNull(),
  status: text('status').notNull(),
  revision: integer('revision').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const canonEntries = sqliteTable('canon_entries', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  sideStoryGroupId: text('side_story_group_id'),
  category: text('category').notNull(),
  name: text('name').notNull(),
  aliasesJson: text('aliases_json').notNull(),
  content: text('content').notNull(),
  metadataJson: text('metadata_json').notNull(),
  status: text('status').notNull(),
  revision: integer('revision').notNull(),
  sourceEpisodeId: text('source_episode_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const improvements = sqliteTable('improvements', {
  id: text('id').primaryKey(),
  scope: text('scope').notNull(),
  projectId: text('project_id'),
  title: text('title').notNull(),
  rule: text('rule').notNull(),
  rationale: text('rationale').notNull(),
  category: text('category').notNull(),
  tagsJson: text('tags_json').notNull(),
  beforeExample: text('before_example'),
  afterExample: text('after_example'),
  source: text('source').notNull(),
  confidence: real('confidence').notNull(),
  duplicateOfId: text('duplicate_of_id'),
  conflictsWithIdsJson: text('conflicts_with_ids_json').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull(),
  revision: integer('revision').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const improvementBatchIdempotency = sqliteTable('improvement_batch_idempotency', {
  idempotencyKey: text('idempotency_key').primaryKey(),
  requestHash: text('request_hash').notNull(),
  responseJson: text('response_json').notNull(),
  createdAt: text('created_at').notNull(),
});

export const memoryChunks = sqliteTable('memory_chunks', {
  id: text('id').primaryKey(),
  projectId: text('project_id'),
  sourceType: text('source_type').notNull(),
  sourceId: text('source_id').notNull(),
  flowKey: text('flow_key').notNull().default('SHARED'),
  flowPosition: integer('flow_position'),
  ordinal: integer('ordinal').notNull(),
  content: text('content').notNull(),
  contentHash: text('content_hash').notNull(),
  embeddingModel: text('embedding_model'),
  embeddingJson: text('embedding_json'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const aiRuns = sqliteTable('ai_runs', {
  id: text('id').primaryKey(),
  task: text('task').notNull(),
  projectId: text('project_id'),
  episodeId: text('episode_id'),
  model: text('model').notNull(),
  promptRefsJson: text('prompt_refs_json').notNull(),
  contextHash: text('context_hash').notNull(),
  memoryRevisionHash: text('memory_revision_hash').notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  latencyMs: integer('latency_ms'),
  status: text('status').notNull(),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
});

export const chatThreads = sqliteTable('chat_threads', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  title: text('title').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const chatMessages = sqliteTable('chat_messages', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  threadId: text('thread_id'),
  clientMessageId: text('client_message_id').notNull(),
  role: text('role').notNull(),
  content: text('content').notNull(),
  status: text('status').notNull(),
  error: text('error'),
  runId: text('run_id'),
  createdAt: text('created_at').notNull(),
});

export const chatProposals = sqliteTable('chat_proposals', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  messageId: text('message_id').notNull(),
  kind: text('kind').notNull(),
  operation: text('operation').notNull(),
  title: text('title').notNull(),
  targetId: text('target_id'),
  beforeJson: text('before_json').notNull(),
  afterJson: text('after_json').notNull(),
  effectsJson: text('effects_json').notNull(),
  activeArcsJson: text('active_arcs_json'),
  status: text('status').notNull(),
  resultJson: text('result_json'),
  indexTargetsJson: text('index_targets_json').notNull(),
  createdAt: text('created_at').notNull(),
  appliedAt: text('applied_at'),
});

export const editorAiMessages = sqliteTable('editor_ai_messages', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  episodeId: text('episode_id').notNull(),
  clientMessageId: text('client_message_id').notNull(),
  role: text('role').notNull(),
  content: text('content').notNull(),
  status: text('status').notNull(),
  requestJson: text('request_json'),
  editJson: text('edit_json'),
  appliedAt: text('applied_at'),
  error: text('error'),
  runId: text('run_id'),
  createdAt: text('created_at').notNull(),
});

export const schema = {
  editorAiMessages,
  chatThreads,
  chatMessages,
  chatProposals,
  projects,
  projectCreationSessions,
  sideStoryGroups,
  sideStoryGroupIdempotency,
  episodes,
  episodeIdempotency,
  episodeSummaries,
  sceneStates,
  arcs,
  canonEntries,
  improvements,
  improvementBatchIdempotency,
  memoryChunks,
  aiRuns,
};
