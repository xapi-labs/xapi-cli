/**
 * CLI argument parser.
 *
 * Supports:
 *   --flag value        space-separated value
 *   --flag=value        inline value (also allows values that start with "--")
 *   --flag              boolean (stored as "true")
 *   --                  end of flags; everything after is treated as positional
 */

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let i = 0;
  let onlyPositional = false;
  while (i < argv.length) {
    const arg = argv[i];
    if (!onlyPositional && arg === '--') {
      // A bare "--" ends flag parsing; the rest is positional.
      onlyPositional = true;
      i++;
      continue;
    }
    if (!onlyPositional && arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        // --key=value — unambiguous, so the value may start with "--".
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        i++;
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = 'true';
        i++;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { positional, flags };
}
