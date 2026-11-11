import {BodyRequestSigner} from "../bodies/request-proof.js";
import {OnboardingRepository} from "../onboarding/repository.js";
import {KeyEncryptor} from "../identity/key-encryption.js";
import { loadConfig } from "../config.js";
import { ProviderDatabase } from "../db/database.js";
import {withFreshServingGenerations} from "../db/serving.js";
import { DeliveryRepository } from "../delivery/repository.js";
import { BodyRetriever } from "../delivery/retriever.js";
import { DeliveryWorker } from "../delivery/worker.js";
import { SafeHttpsTransport } from "../discovery/safe-fetch.js";
import { createHailDidResolver } from "../plc/public-resolver.js";

const config = loadConfig();
const database = new ProviderDatabase(config.databaseUrl);
try {
  await database.migrate();
  const transport = new SafeHttpsTransport();
  const resolver=createHailDidResolver(config,database.sql);
  const signer=new BodyRequestSigner(database.sql,new OnboardingRepository(database.sql),new KeyEncryptor(config.keyEncryptionKey),resolver,config.hailServiceBase);
  const worker = new DeliveryWorker(new DeliveryRepository(database.sql),
    new BodyRetriever(resolver, transport.fetchBody, transport.validateTarget, signer.sign));
  const outcome = await withFreshServingGenerations(database.sql,()=>worker.processOne());
  console.info(JSON.stringify({ outcome }));
} finally { await database.close(); }
