import { expect, test } from 'vitest';
import { scanSql } from '../scripts/lib/sql.ts';

test('a comment marker inside a string literal is not a comment', () => {
  expect(scanSql("SELECT '--x', 1 -- real\n").comments).toEqual([' real']);
});

test('a block comment and a dollar-quoted body are told apart', () => {
  expect(scanSql('SELECT $$ -- no $$ /* yes */').comments).toEqual([' yes ']);
});

test('code blanks comments, literals, and dollar quotes, and turns a meta-command into a semicolon', () => {
  const { code } = scanSql("SELECT 'a;b', \"c;d\", $$e;f$$ -- g;h\n/* i;j */ FROM t\n\\getenv x Y\nSELECT 2");
  expect(code.split(';').map((statement) => statement.replace(/\s+/g, ' ').trim())).toEqual(['SELECT , , FROM t', 'SELECT 2']);
});

test('a doubled quote inside a literal does not end it', () => {
  expect(scanSql("SELECT 'it''s -- not' -- yes\n").comments).toEqual([' yes']);
});

test('a $1 placeholder is not a dollar quote', () => {
  expect(scanSql('SELECT $1, $2 -- c $3').comments).toEqual([' c $3']);
});
