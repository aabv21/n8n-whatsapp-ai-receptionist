/** The index just past the next `token` at or after `from`, or the end of `sql` if there is none. */
function skipPast(sql: string, token: string, from: number): number {
  const at = sql.indexOf(token, from);
  return at === -1 ? sql.length : at + token.length;
}

/**
 * One pass over `sql`, as `code` and `comments`. `code` is `sql` with its comments, string
 * literals, quoted identifiers, and dollar-quoted bodies blanked out, and each psql meta-command
 * (a backslash, up to the end of its line) turned into `;`, so what's left splits into statements
 * on `;`. `comments` holds the text of each `--` line comment and block comment, without its markers, in
 * source order.
 */
export function scanSql(sql: string): { code: string; comments: string[] } {
  let out = '';
  const comments: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    // A dollar-quote tag is $$ or $name$, where the name can't start with a digit (so $1 isn't one).
    const dollarMatch = /^\$[A-Za-z0-9_]*\$/.exec(rest)?.[0];
    const dollarTag = dollarMatch && !/^\$\d/.test(dollarMatch) ? dollarMatch : undefined;
    if (rest.startsWith('--')) {
      const lineEnd = sql.indexOf('\n', i);
      const end = lineEnd === -1 ? sql.length : lineEnd;
      comments.push(sql.slice(i + 2, end));
      i = end;
      out += ' ';
    } else if (rest.startsWith('/*')) {
      const closed = sql.indexOf('*/', i + 2);
      comments.push(sql.slice(i + 2, closed === -1 ? sql.length : closed));
      i = skipPast(sql, '*/', i + 2);
      out += ' ';
    } else if (dollarTag) {
      i = skipPast(sql, dollarTag, i + dollarTag.length);
      out += ' ';
    } else if (rest.startsWith("'") || rest.startsWith('"')) {
      const quote = rest.charAt(0);
      let j = i + 1;
      for (;;) {
        j = skipPast(sql, quote, j);
        if (j >= sql.length || sql.charAt(j) !== quote) break;
        j += 1; // a doubled quote is an escaped one, so the literal goes on
      }
      i = j;
      out += ' ';
    } else if (rest.startsWith('\\')) {
      const lineEnd = sql.indexOf('\n', i);
      i = lineEnd === -1 ? sql.length : lineEnd;
      out += ';';
    } else {
      out += sql.charAt(i);
      i += 1;
    }
  }
  return { code: out, comments };
}
