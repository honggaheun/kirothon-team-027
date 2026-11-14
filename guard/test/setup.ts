// vitest setup: fast-check global config; verbose 2 keeps the Execution summary in failures.
import fc from 'fast-check';

fc.configureGlobal({ verbose: 2 });
