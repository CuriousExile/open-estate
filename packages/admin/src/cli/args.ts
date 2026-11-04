import { parseArgs, type ParseArgsConfig } from 'node:util';

type ParseArgsOptionsConfig = NonNullable<ParseArgsConfig['options']>;

/** Invalid command line; the CLI prints the message plus usage and exits with `EXIT_USAGE`. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** One call of the Admin-API, relative to the base URL (stage path included there). */
export interface AdminCall {
  method: HttpMethod;
  path: string;
  body?: Record<string, unknown>;
}

/** Options accepted by every command. */
export interface GlobalOptions {
  url?: string;
  region?: string;
  profile?: string;
}

export type CliCommand =
  | { kind: 'help'; text: string }
  | { kind: 'http'; name: string; call: AdminCall; global: GlobalOptions }
  | { kind: 'reload'; functions: string[]; global: GlobalOptions };

/** Comma-separated Lambda function names `reload` uses when no `--function` is given. */
export const RELOAD_FUNCTIONS_ENV = 'OPEN_ESTATE_RELOAD_FUNCTIONS';

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;
type Action = { kind: 'http'; call: AdminCall } | { kind: 'reload'; functions: string[] };

interface CommandSpec {
  summary: string;
  /** Positional arguments and command options, for the usage text. */
  synopsis: string;
  positionals: readonly string[];
  options: ParseArgsOptionsConfig;
  build(values: Values, positionals: readonly string[], env: NodeJS.ProcessEnv): Action;
}

const GLOBAL_OPTIONS = {
  url: { type: 'string' },
  region: { type: 'string' },
  profile: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsOptionsConfig;

const RATE_LIMIT_OPTIONS = {
  requests: { type: 'string' },
  'window-seconds': { type: 'string' },
} as const satisfies ParseArgsOptionsConfig;

const str = (values: Values, name: string): string | undefined => {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
};

/** Ranges are checked by the Admin-API, which names the rejected value (Req 17.8). */
function integer(values: Values, name: string): number | undefined {
  const value = str(values, name);
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value.trim())) {
    throw new UsageError(`--${name} must be an integer; got "${value}"`);
  }
  return Number(value);
}

function rateLimit(values: Values): { requests: number; windowSeconds: number } | undefined {
  const requests = integer(values, 'requests');
  const windowSeconds = integer(values, 'window-seconds');
  if (requests === undefined && windowSeconds === undefined) return undefined;
  if (requests === undefined || windowSeconds === undefined) {
    throw new UsageError('--requests and --window-seconds must be given together');
  }
  return { requests, windowSeconds };
}

function requiredRateLimit(values: Values) {
  const limit = rateLimit(values);
  if (limit === undefined) throw new UsageError('--requests and --window-seconds are required');
  return limit;
}

/** Path parameters are always percent-encoded, so ids cannot escape their segment. */
const segment = (value: string | undefined): string => encodeURIComponent(value ?? '');

const http = (call: AdminCall): Action => ({ kind: 'http', call });

const COMMANDS: Record<string, CommandSpec> = {
  'create-key': {
    summary: 'Create an API key (plaintext is shown exactly once)',
    synopsis: '[--expires-at <ISO-8601>] [--requests <n> --window-seconds <n>]',
    positionals: [],
    options: { 'expires-at': { type: 'string' }, ...RATE_LIMIT_OPTIONS },
    build(values) {
      const expiresAt = str(values, 'expires-at');
      const limit = rateLimit(values);
      return http({
        method: 'POST',
        path: '/admin/api-keys',
        body: {
          ...(expiresAt !== undefined && { expiresAt }),
          ...(limit !== undefined && { rateLimit: limit }),
        },
      });
    },
  },
  'revoke-key': {
    summary: 'Revoke an API key',
    synopsis: '<keyId>',
    positionals: ['keyId'],
    options: {},
    build: (_values, [keyId]) =>
      http({ method: 'DELETE', path: `/admin/api-keys/${segment(keyId)}` }),
  },
  'set-key-rate-limit': {
    summary: 'Set the rate limit of one API key',
    synopsis: '<keyId> --requests <n> --window-seconds <n>',
    positionals: ['keyId'],
    options: RATE_LIMIT_OPTIONS,
    build: (values, [keyId]) =>
      http({
        method: 'PUT',
        path: `/admin/api-keys/${segment(keyId)}/rate-limit`,
        body: requiredRateLimit(values),
      }),
  },
  'set-rate-limit': {
    summary: 'Set the global rate limit',
    synopsis: '--requests <n> --window-seconds <n>',
    positionals: [],
    options: RATE_LIMIT_OPTIONS,
    build: (values) =>
      http({ method: 'PUT', path: '/admin/rate-limit', body: requiredRateLimit(values) }),
  },
  'set-access-mode': {
    summary: 'Set the access mode (open | api-keys)',
    synopsis: '<mode>',
    positionals: ['mode'],
    options: {},
    build: (_values, [mode]) => http({ method: 'PUT', path: '/admin/access-mode', body: { mode } }),
  },
  'request-deletion': {
    summary: 'Request deletion of one listing or of all listings of a source',
    synopsis: '--listing-id <id> | --source <source>',
    positionals: [],
    options: { 'listing-id': { type: 'string' }, source: { type: 'string' } },
    build(values) {
      const listingId = str(values, 'listing-id');
      const source = str(values, 'source');
      if ((listingId === undefined) === (source === undefined)) {
        throw new UsageError('Specify exactly one of --listing-id or --source');
      }
      return http({
        method: 'POST',
        path: '/admin/deletions',
        body: listingId !== undefined ? { listingId } : { source },
      });
    },
  },
  'get-deletion': {
    summary: 'Show the status of a deletion request',
    synopsis: '<requestId>',
    positionals: ['requestId'],
    options: {},
    build: (_values, [requestId]) =>
      http({ method: 'GET', path: `/admin/deletions/${segment(requestId)}` }),
  },
  'unblock-listing': {
    summary: 'Lift the deletion block of a listing id',
    synopsis: '<listingId>',
    positionals: ['listingId'],
    options: {},
    build: (_values, [listingId]) =>
      http({ method: 'DELETE', path: `/admin/deletion-blocklist/${segment(listingId)}` }),
  },
  reload: {
    summary: 'Increment CONFIG_VERSION of Lambda functions to force cold starts',
    synopsis: `[--function <name>]...  (default: $${RELOAD_FUNCTIONS_ENV}, comma-separated)`,
    positionals: [],
    options: { function: { type: 'string', multiple: true } },
    build(values, _positionals, env) {
      const flags = values['function'];
      const names = Array.isArray(flags)
        ? flags.filter((name): name is string => typeof name === 'string')
        : (env[RELOAD_FUNCTIONS_ENV] ?? '').split(',');
      const functions = [
        ...new Set(names.map((name) => name.trim()).filter((name) => name !== '')),
      ];
      if (functions.length === 0) {
        throw new UsageError(`No functions given: use --function or set ${RELOAD_FUNCTIONS_ENV}`);
      }
      return { kind: 'reload', functions };
    },
  },
};

const GLOBAL_USAGE = [
  'Global options:',
  '  --url <url>        Admin-API base URL incl. stage (default: $OPEN_ESTATE_ADMIN_URL)',
  '  --region <region>  AWS region (default: $AWS_REGION, $AWS_DEFAULT_REGION or the URL host)',
  '  --profile <name>   AWS profile of the default credential chain (default: $AWS_PROFILE)',
  '  -h, --help         Show help',
].join('\n');

const commandLine = (name: string, spec: CommandSpec) =>
  `open-estate-admin ${name}${spec.synopsis === '' ? '' : ` ${spec.synopsis}`}`;

export function usage(): string {
  const commands = Object.entries(COMMANDS).map(
    ([name, spec]) => `  ${name.padEnd(20)}${spec.summary}`,
  );
  return [
    'Usage: open-estate-admin <command> [arguments] [options]',
    '',
    'Commands:',
    ...commands,
    '',
    GLOBAL_USAGE,
    '',
    'Run "open-estate-admin <command> --help" for the arguments of a command.',
  ].join('\n');
}

function commandUsage(name: string, spec: CommandSpec): string {
  return [`Usage: ${commandLine(name, spec)} [options]`, '', spec.summary, '', GLOBAL_USAGE].join(
    '\n',
  );
}

/** Parses `argv` (without node and script path) into a command; throws `UsageError`. */
export function parseCommand(argv: readonly string[], env: NodeJS.ProcessEnv): CliCommand {
  const [name, ...rest] = argv;
  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    return { kind: 'help', text: usage() };
  }
  const spec = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (spec === undefined) throw new UsageError(`Unknown command "${name}"`);

  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...GLOBAL_OPTIONS, ...spec.options },
      allowPositionals: true,
      strict: true,
    });
  } catch (cause) {
    throw new UsageError(cause instanceof Error ? cause.message : String(cause));
  }
  const { values, positionals } = parsed;
  if (values['help'] === true) return { kind: 'help', text: commandUsage(name, spec) };

  if (positionals.length !== spec.positionals.length) {
    const expected = spec.positionals.map((arg) => `<${arg}>`).join(' ') || 'no arguments';
    throw new UsageError(`${name} expects ${expected}; got ${positionals.length} argument(s)`);
  }
  for (const [index, arg] of spec.positionals.entries()) {
    if (positionals[index]?.trim() === '') throw new UsageError(`<${arg}> must not be empty`);
  }

  const url = str(values, 'url');
  const region = str(values, 'region');
  const profile = str(values, 'profile');
  const global: GlobalOptions = {
    ...(url !== undefined && { url }),
    ...(region !== undefined && { region }),
    ...(profile !== undefined && { profile }),
  };
  const action = spec.build(values, positionals, env);
  return action.kind === 'http'
    ? { kind: 'http', name, call: action.call, global }
    : { kind: 'reload', functions: action.functions, global };
}
