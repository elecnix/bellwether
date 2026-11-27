// Reading a harness's command-line arguments.

/** The value of `--flag value` or `--flag=value` in a list of arguments. */
export function argValue(args: string[] | undefined, flag: string): string | undefined {
  if (!args) return undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === flag) return args[index + 1] ?? '';
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}
