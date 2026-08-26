/** Quote one value as a literal POSIX-shell argument. */
export function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Copy-ready login instructions for this dashboard deployment. */
export function buildCliAuthLoginHint(apiBaseUrl: string): string {
  return [
    "npm i -g @axel/cli",
    `axel auth login --api-base ${quoteShellArgument(apiBaseUrl)}   # paste the token above when prompted`,
  ].join("\n");
}
