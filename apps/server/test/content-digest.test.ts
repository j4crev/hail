import { expect, it } from 'vitest';
import vectors from '../../../spec/vectors/content-digest.json';
import { validateContentDigest } from '../src/http/content-digest.js';

it.each(vectors.cases)('Content-Digest: $name', ({header, valid}) => {
  expect(validateContentDigest(header, Buffer.from(vectors.contentHex, 'hex'))).toBe(valid);
});
it('bounds combined field bytes and dictionary members before hashing', () => {
  const bytes = new Uint8Array();
  expect(validateContentDigest('x=::;p="'+'a'.repeat(8192)+'"', bytes)).toBe(false);
  expect(validateContentDigest(Array.from({length:16},(_,i)=>`x${i}=::`).join(', '), bytes)).toBe(true);
  expect(validateContentDigest(Array.from({length:17},(_,i)=>`x${i}=::`).join(', '), bytes)).toBe(false);
  expect(validateContentDigest('x=::\r\n', bytes)).toBe(false);
});
