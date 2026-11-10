import { expect, it } from "vitest";
import { SourceAdmission } from "../src/admission.js";

it("limits registration by IPv6 prefix while keeping enrollment and other sources independent", () => {
  const limiter = new SourceAdmission();
  for (let i = 1; i <= 5; i++) expect(limiter.take("2001:4860:1:2::" + i, true, 1000)).toBe(true);
  expect(limiter.take("2001:4860:1:2::99", true, 1000)).toBe(false);
  expect(limiter.take("2001:4860:1:3::1", true, 1000)).toBe(true);
  expect(limiter.take("2001:4860:1:2::1", false, 1000)).toBe(true);
  expect(limiter.take("2001:4860:1:2::1", true, 61000)).toBe(true);
});

it("abandons a request body that stalls within its byte allowance", async () => {
  const { boundedBody } = await import("../src/http.js");
  let cancelled = false;
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) { controller.enqueue(new Uint8Array([123])); },
    cancel() { cancelled = true; },
  });
  expect(await boundedBody({ body, headers: new Headers() }, 4096, 5)).toBeNull();
  expect(cancelled).toBe(true);
});
