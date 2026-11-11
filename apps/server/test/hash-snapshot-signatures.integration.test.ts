import {SQL} from 'bun';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {it,expect} from 'vitest';
import {signSnapshot} from '../src/migration/snapshot-signature.js';
const integration=process.env.DATABASE_URL?it:it.skip;
integration('requires current snapshot signatures and refuses lossy rollback',async()=>{
 const db=new SQL(process.env.DATABASE_URL!),connection=await db.reserve(),schema='hash_snapshot_'+randomUUID().replaceAll('-','');
 try{
  await connection.unsafe(`CREATE SCHEMA "${schema}"`);
  await connection.unsafe(`SET search_path TO "${schema}"`);
  // Exact predecessor constraints, isolated from unrelated account prerequisites.
  await connection.unsafe(`CREATE TABLE schema_migrations(version integer); INSERT INTO schema_migrations VALUES(109);
   CREATE TABLE provider_migration_exports(signature bytea CHECK(octet_length(signature)=64));
   CREATE TABLE pending_migration_imports(signature bytea CHECK(octet_length(signature)=64));`);
  await connection.unsafe(await readFile(new URL('../migrations/0109_hash_snapshot_signatures.sql',import.meta.url),'utf8'));
  await expect(connection`INSERT INTO provider_migration_exports VALUES(${new Uint8Array(64)})`).rejects.toThrow();
  await expect(connection`INSERT INTO pending_migration_imports VALUES(${new Uint8Array(64)})`).rejects.toThrow();
  const keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
  const current=await signSnapshot(new TextEncoder().encode('{"version":9}'),9,'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',keys.privateKey);
  await connection`INSERT INTO provider_migration_exports VALUES(${current})`;
  await connection`INSERT INTO pending_migration_imports VALUES(${current})`;
  const rollback=await readFile(new URL('../migrations/rollback/0109_hash_snapshot_signatures.sql',import.meta.url),'utf8');
  await expect(connection.unsafe(rollback)).rejects.toThrow();
  await connection.unsafe('ROLLBACK');
  for(const table of ['provider_migration_exports','pending_migration_imports']){
   const rows=await connection.unsafe(`SELECT signature FROM ${table} ORDER BY octet_length(signature)`);
   expect(rows).toHaveLength(1);
   expect(new Uint8Array(rows[0].signature)).toEqual(current);
   // Fixture-only cleanup makes the pre-write rollback case testable.
   await connection.unsafe(`DELETE FROM ${table} WHERE octet_length(signature)>64`);
  }
  await connection.unsafe(rollback);
  expect((await connection`SELECT version FROM schema_migrations`).length).toBe(0);
  await expect(connection`INSERT INTO provider_migration_exports VALUES(${current})`).rejects.toThrow();
 }finally{
  await connection.unsafe('ROLLBACK');
  await connection.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  connection.release();await db.close();
 }
});
