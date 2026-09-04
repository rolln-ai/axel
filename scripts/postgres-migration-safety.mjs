import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function tokenizeSql(sql) {
  const tokens = [];
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (sql.startsWith("--", index)) {
      const newline = sql.indexOf("\n", index + 2);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (sql.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth !== 0) throw new Error("unterminated_sql_comment");
      continue;
    }
    if (character === "'") {
      let value = "";
      const escapeString = tokens.at(-1)?.type === "word" && tokens.at(-1).value === "e";
      index += 1;
      let terminated = false;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          value += "'";
          index += 2;
        } else if (sql[index] === "'") {
          index += 1;
          terminated = true;
          break;
        } else if (escapeString && sql[index] === "\\" && index + 1 < sql.length) {
          value += sql[index + 1];
          index += 2;
        } else {
          value += sql[index];
          index += 1;
        }
      }
      if (!terminated) throw new Error("unterminated_sql_string");
      tokens.push({ type: "string", value, dollarQuoted: false });
      continue;
    }
    if (character === '"') {
      if (
        tokens.at(-1)?.type === "punctuation"
        && tokens.at(-1).value === "&"
        && tokens.at(-2)?.type === "word"
        && tokens.at(-2).value === "u"
      ) {
        // PostgreSQL decodes U&"..." before resolving an identifier. Treat
        // that syntax as unsupported instead of comparing the escaped source
        // spelling with security-sensitive names such as set_config.
        throw new Error("unsupported_unicode_escaped_identifier");
      }
      let value = "";
      index += 1;
      let terminated = false;
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') {
          value += '"';
          index += 2;
        }
        else if (sql[index] === '"') {
          index += 1;
          terminated = true;
          break;
        } else {
          value += sql[index];
          index += 1;
        }
      }
      if (!terminated) throw new Error("unterminated_sql_identifier");
      tokens.push({ type: "word", value: value.toLowerCase(), quoted: true });
      continue;
    }
    if (character === "$") {
      const tag = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (tag) {
        const bodyStart = index + tag.length;
        const bodyEnd = sql.indexOf(tag, bodyStart);
        if (bodyEnd === -1) throw new Error("unterminated_sql_dollar_quote");
        tokens.push({
          type: "string",
          value: sql.slice(bodyStart, bodyEnd),
          dollarQuoted: true,
        });
        index = bodyEnd + tag.length;
        continue;
      }
    }
    if (character === "\\") {
      const command = sql.slice(index + 1).match(/^[A-Za-z_]+/)?.[0] ?? "";
      tokens.push({ type: "psql_meta", value: command.toLowerCase() });
      index += command.length + 1;
      continue;
    }
    const word = sql.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*/)?.[0];
    if (word) {
      tokens.push({ type: "word", value: word.toLowerCase() });
      index += word.length;
      continue;
    }
    tokens.push({ type: "punctuation", value: character });
    index += 1;
  }

  return tokens;
}

function wordsMatch(tokens, index, values) {
  return values.every(
    (value, offset) =>
      tokens[index + offset]?.type === "word"
      && tokens[index + offset].value === value,
  );
}

function isSafeConstraintDropExecute(tokens, index) {
  if (tokens[index + 1]?.type !== "word" || tokens[index + 1].value !== "format") {
    return false;
  }
  if (tokens[index + 2]?.type !== "punctuation" || tokens[index + 2].value !== "(") {
    return false;
  }

  let depth = 0;
  let closingIndex = -1;
  for (let cursor = index + 2; cursor < tokens.length; cursor += 1) {
    const candidate = tokens[cursor];
    if (candidate.type !== "punctuation") continue;
    if (candidate.value === "(") depth += 1;
    if (candidate.value === ")") {
      depth -= 1;
      if (depth === 0) {
        closingIndex = cursor;
        break;
      }
    }
  }
  if (closingIndex === -1) return false;
  if (
    tokens[closingIndex + 1]?.type !== "punctuation"
    || tokens[closingIndex + 1].value !== ";"
  ) {
    return false;
  }
  const formatString = tokens[index + 3];
  return formatString?.type === "string"
    && /^ALTER\s+TABLE\s+[a-z_][a-z0-9_]*\s+DROP\s+CONSTRAINT\s+%I$/i.test(
      formatString.value.trim(),
    );
}

function statementTokens(tokens, index) {
  let start = index;
  while (
    start > 0
    && !(tokens[start - 1].type === "punctuation" && tokens[start - 1].value === ";")
  ) {
    start -= 1;
  }
  let end = index;
  while (
    end < tokens.length
    && !(tokens[end].type === "punctuation" && tokens[end].value === ";")
  ) {
    end += 1;
  }
  return tokens.slice(start, end);
}

function statementWords(tokens, index) {
  return statementTokens(tokens, index)
    .filter((token) => token.type === "word")
    .map((token) => token.value)
    .join(" ");
}

function isSafePublicPrivilegeRevoke(tokens, index) {
  const words = statementWords(tokens, index);
  return words === "revoke all privileges on table delivery_canary_receipts from public"
    || words === "revoke all privileges on all tables in schema public from public"
    || words === "revoke all privileges on all sequences in schema public from public"
    || words === "revoke all privileges on all routines in schema public from public"
    || words === "revoke execute on function public axel_minimize_billing_event_payload from public"
    || words === "alter default privileges revoke execute on routines from public";
}

function isCreateTriggerExecuteClause(tokens, index) {
  const statement = statementTokens(tokens, index);
  const executeOffset = statement.indexOf(tokens[index]);
  const wordsBeforeExecute = statement
    .slice(0, executeOffset)
    .filter((token) => token.type === "word")
    .map((token) => token.value);
  return wordsBeforeExecute[0] === "create"
    && wordsBeforeExecute.includes("trigger")
    && !wordsBeforeExecute.includes("do");
}

function tokensAreUnsafe(tokens, depth) {
  if (tokens.some((token) => token.type === "psql_meta")) return true;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "word") continue;

    if (
      wordsMatch(tokens, index, ["discard", "all"])
      || wordsMatch(tokens, index, ["create", "database"])
      || wordsMatch(tokens, index, ["create", "extension"])
      || wordsMatch(tokens, index, ["alter", "extension"])
      || wordsMatch(tokens, index, ["drop", "extension"])
      || wordsMatch(tokens, index, ["create", "role"])
      || wordsMatch(tokens, index, ["create", "user"])
      || wordsMatch(tokens, index, ["create", "group"])
      || wordsMatch(tokens, index, ["alter", "role"])
      || wordsMatch(tokens, index, ["alter", "user"])
      || wordsMatch(tokens, index, ["alter", "group"])
      || wordsMatch(tokens, index, ["drop", "role"])
      || wordsMatch(tokens, index, ["drop", "user"])
      || wordsMatch(tokens, index, ["drop", "group"])
      || wordsMatch(tokens, index, ["drop", "owned"])
      || wordsMatch(tokens, index, ["security", "definer"])
      || wordsMatch(tokens, index, ["reassign", "owned"])
      || wordsMatch(tokens, index, ["owner", "to"])
      || wordsMatch(tokens, index, ["reset", "all"])
      || wordsMatch(tokens, index, ["reset", "role"])
      || wordsMatch(tokens, index, ["reset", "search_path"])
      || wordsMatch(tokens, index, ["reset", "session", "authorization"])
      || wordsMatch(tokens, index, ["set", "role"])
      || wordsMatch(tokens, index, ["set", "local", "role"])
      || wordsMatch(tokens, index, ["set", "session", "role"])
      || wordsMatch(tokens, index, ["set", "search_path"])
      || wordsMatch(tokens, index, ["set", "local", "search_path"])
      || wordsMatch(tokens, index, ["set", "session", "search_path"])
      || wordsMatch(tokens, index, ["set", "schema"])
      || wordsMatch(tokens, index, ["set", "local", "schema"])
      || wordsMatch(tokens, index, ["set", "session", "schema"])
      || wordsMatch(tokens, index, ["set", "session", "authorization"])
      || token.value === "set_config"
    ) {
      return true;
    }

    if (token.value === "grant") return true;
    if (token.value === "revoke" && !isSafePublicPrivilegeRevoke(tokens, index)) return true;
    if (
      wordsMatch(tokens, index, ["alter", "default", "privileges"])
      && !isSafePublicPrivilegeRevoke(tokens, index)
    ) {
      return true;
    }

    if (token.value === "execute") {
      if (
        ["function", "procedure"].includes(tokens[index + 1]?.value)
        && isCreateTriggerExecuteClause(tokens, index)
      ) {
        continue;
      }
      if (isSafePublicPrivilegeRevoke(tokens, index)) continue;
      if (!isSafeConstraintDropExecute(tokens, index)) return true;
    }

    if (wordsMatch(tokens, index, ["create", "schema"])) {
      for (let cursor = index + 2; cursor < tokens.length; cursor += 1) {
        if (tokens[cursor].type === "punctuation" && tokens[cursor].value === ";") break;
        if (tokens[cursor].type === "word" && tokens[cursor].value === "authorization") {
          return true;
        }
      }
    }
  }

  if (depth >= 8) return true;
  return tokens.some((token, index) => {
    if (token.type !== "string") return false;
    if (token.dollarQuoted) return unsafeMigrationSessionControl(token.value, depth + 1);
    const previous = tokens[index - 1];
    const beforePrevious = tokens[index - 2];
    const bodyPrefix = previous?.type === "word" && ["as", "do"].includes(previous.value);
    const eBodyPrefix = previous?.type === "word" && previous.value === "e"
      && beforePrevious?.type === "word" && ["as", "do"].includes(beforePrevious.value);
    const unicodeBodyPrefix = previous?.type === "punctuation" && previous.value === "&"
      && beforePrevious?.type === "word" && beforePrevious.value === "u"
      && tokens[index - 3]?.type === "word"
      && ["as", "do"].includes(tokens[index - 3].value);
    if (eBodyPrefix || unicodeBodyPrefix) return true;
    return bodyPrefix && unsafeMigrationSessionControl(token.value, depth + 1);
  });
}

export function unsafeMigrationSessionControl(sql, depth = 0) {
  if (typeof sql !== "string" || depth > 8) return true;
  try {
    return tokensAreUnsafe(tokenizeSql(sql), depth);
  } catch {
    return true;
  }
}

function transactionModeFromTokens(tokens) {
  let hasExplicitTransactionControl = false;
  let hasConcurrentIndexOperation = false;
  let statement = [];

  const classifyStatement = () => {
    const words = statement
      .filter((token) => token.type === "word")
      .map((token) => token.value);
    statement = [];
    if (words.length === 0) return;

    if (
      words[0] === "begin"
      || words[0] === "commit"
      || words[0] === "end"
      || words[0] === "rollback"
      || words[0] === "abort"
      || words[0] === "savepoint"
      || (words[0] === "start" && words[1] === "transaction")
      || (words[0] === "release" && words[1] === "savepoint")
      || (words[0] === "prepare" && words[1] === "transaction")
      || (words[0] === "set" && words[1] === "transaction")
    ) {
      hasExplicitTransactionControl = true;
    }

    const concurrentIndex = words.some((word, index) => {
      if (word === "create") {
        const indexOffset = words[index + 1] === "unique" ? index + 2 : index + 1;
        return words[indexOffset] === "index" && words[indexOffset + 1] === "concurrently";
      }
      if (word === "drop") {
        return words[index + 1] === "index" && words[index + 2] === "concurrently";
      }
      return word === "reindex" && words.slice(index + 1).includes("concurrently");
    });
    if (concurrentIndex) hasConcurrentIndexOperation = true;
  };

  for (const token of tokens) {
    if (token.type === "punctuation" && token.value === ";") classifyStatement();
    else statement.push(token);
  }
  classifyStatement();

  if (hasExplicitTransactionControl && hasConcurrentIndexOperation) return "mixed_exceptional";
  if (hasExplicitTransactionControl) return "explicit_transaction";
  if (hasConcurrentIndexOperation) return "concurrent_index";
  return "atomic";
}

export function migrationTransactionMode(sql) {
  if (typeof sql !== "string") return "invalid";
  try {
    return transactionModeFromTokens(tokenizeSql(sql));
  } catch {
    return "invalid";
  }
}

let invokedDirectly = false;
try {
  invokedDirectly = process.argv[1]
    ? realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
    : false;
} catch {
  invokedDirectly = false;
}
if (invokedDirectly) {
  if (process.argv.length !== 4 || process.argv[2] !== "--transaction-mode") {
    process.stderr.write("usage: postgres-migration-safety.mjs --transaction-mode FILE\n");
    process.exit(2);
  }
  let sql;
  try {
    sql = readFileSync(process.argv[3], "utf8");
  } catch {
    process.stderr.write("migration_transaction_mode_read_failed\n");
    process.exit(1);
  }
  const mode = migrationTransactionMode(sql);
  if (mode === "invalid") {
    process.stderr.write("migration_transaction_mode_invalid_sql\n");
    process.exit(1);
  }
  process.stdout.write(`${mode}\n`);
}
