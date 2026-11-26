// These single-consumer fixtures use a query-only database. The cross-replica
// scheduler tests exercise the production Postgres session lock separately.
import {registerStudio as register} from '../src/studio.js';
export * from '../src/studio.js';

export function registerStudio(...[app,pool,deps]: Parameters<typeof register>) {
  return register(app,pool,{...deps,plannerSession:work=>work(pool)});
}
