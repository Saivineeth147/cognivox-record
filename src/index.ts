/**
 * @cognivox/record — turn a running app into a test suite, and run it again
 * with no database.
 *
 * Two entry points: the commander registrations used by the Cognivox CLI, and
 * the session functions for anyone embedding recording or replay in their own
 * tooling.
 */

export { registerRecordCommand } from './commands/record';
export { registerReplayCommand } from './commands/replay';

export { runRecordSession } from './record/session';
export type { RecordSessionOptions, RecordSummary, ChildOutcome } from './record/session';
export { runReplaySession } from './replay/session';
export type { ReplaySessionOptions, ReplaySummary } from './replay/session';

export { planRedirects } from './record/dependencyEnv';
export type { RedirectedDependency, RedirectPlan } from './record/dependencyEnv';
export type { DependencyInteraction, ProtocolRecorder } from './record/tcp/protocol';
export type { RecordedExchange } from './record/exchange';

export { RedisRecorder } from './record/protocols/redisRecorder';
export { PostgresRecorder } from './record/protocols/postgresRecorder';
export { MongoRecorder } from './record/protocols/mongoRecorder';
export { RedisReplay } from './replay/redisReplayServer';
export { PostgresReplay } from './replay/postgresReplayServer';
export { MongoReplay } from './replay/mongoReplayServer';
export { DivergenceTracker } from './replay/divergence';
