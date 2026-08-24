import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  type CapturedEvent,
  type Envelope,
  PROTOCOL_VERSION,
  RECORDING_FORMAT_VERSION,
  type RecordingLine,
  type Session,
} from "./index.js";

// The schema and fixtures live outside src/ because they are not TypeScript
// and not built — they are the language-neutral form of this package, read
// verbatim by the Python SDK's own conformance test.
const packageRoot = path.resolve(import.meta.dirname, "..");
const schemaPath = path.join(packageRoot, "schema/wevna-protocol.schema.json");
const fixturesRoot = path.join(packageRoot, "fixtures");

const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema, "protocol");

// Fixtures are named `<Definition>.<description>.json`, so the file itself
// says which $def it is a case for. That keeps one flat directory readable
// and means adding a case needs no registry update.
function definitionOf(file: string): string {
  const definition = file.split(".")[0];
  if (!definition) {
    throw new Error(`fixture ${file} has no definition prefix`);
  }
  return definition;
}

function validatorFor(definition: string) {
  const validate = ajv.getSchema(`protocol#/$defs/${definition}`);
  if (!validate) {
    throw new Error(`no $def named ${definition} in the schema`);
  }
  return validate;
}

function fixtures(kind: "valid" | "invalid"): string[] {
  return readdirSync(path.join(fixturesRoot, kind))
    .filter((f) => f.endsWith(".json"))
    .sort();
}

function load(kind: "valid" | "invalid", file: string): unknown {
  return JSON.parse(readFileSync(path.join(fixturesRoot, kind, file), "utf8"));
}

describe("protocol schema", () => {
  it("is a schema Ajv accepts in strict mode", () => {
    // Strict mode rejects the mistakes that make a schema silently permissive
    // — an unknown keyword, a typo'd `$ref`, a `required` naming a property
    // that was never declared. Without this, a broken schema would still
    // "pass" every fixture below by validating nothing at all.
    expect(ajv.getSchema("protocol")).toBeTypeOf("function");
  });

  it("never sets additionalProperties: false", () => {
    // The protocol's whole forward-compatibility story is that an optional
    // field can be added without breaking a consumer that predates it, which
    // a closed schema would make impossible. Asserted rather than assumed,
    // because it is one keyword away from being broken by a well-meaning
    // edit.
    expect(JSON.stringify(schema)).not.toContain('"additionalProperties":false');
  });

  it("pins the versions the schema allows to the constants this package exports", () => {
    expect(schema.$defs.EventEnvelope.properties.version.minimum).toBe(PROTOCOL_VERSION);
    expect(schema.$defs.RecordingHeader.properties.formatVersion.minimum).toBe(
      RECORDING_FORMAT_VERSION,
    );
  });
});

describe.each(fixtures("valid"))("valid fixture %s", (file) => {
  it("is accepted by its definition", () => {
    const validate = validatorFor(definitionOf(file));
    const ok = validate(load("valid", file));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });
});

describe.each(fixtures("invalid"))("invalid fixture %s", (file) => {
  it("is rejected by its definition", () => {
    const validate = validatorFor(definitionOf(file));
    expect(validate(load("invalid", file))).toBe(false);
  });
});

// The fixtures prove the schema matches hand-written JSON. These prove it
// matches what the TypeScript types actually produce — the two can drift
// apart in opposite directions, and only one of them is what ships.
describe("TypeScript types satisfy the schema", () => {
  it("accepts an Envelope<CapturedEvent> built through the exported types", () => {
    const event: CapturedEvent = {
      id: "e-1",
      kind: "sql.query",
      occurredAt: Date.now(),
      attributes: { query: "select 1", durationMs: 1.5 },
      correlation: { id: "c-1" },
      source: "@wevna/plugin-fetch",
    };
    const envelope: Envelope<CapturedEvent> = {
      version: PROTOCOL_VERSION,
      sessionId: "s-1",
      sequence: 0,
      payload: event,
    };

    const validate = validatorFor("EventEnvelope");
    const ok = validate(JSON.parse(JSON.stringify(envelope)));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("accepts every RecordingLine variant built through the exported types", () => {
    const session: Session = { id: "s-1", startedAt: Date.now(), status: "running" };
    const lines: RecordingLine[] = [
      {
        type: "header",
        formatVersion: RECORDING_FORMAT_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        session,
        recordingStartedAt: Date.now(),
      },
      {
        type: "event",
        envelope: {
          version: PROTOCOL_VERSION,
          sessionId: session.id,
          sequence: 1,
          payload: { id: "e-1", kind: "console.log", occurredAt: Date.now(), attributes: {} },
        },
      },
      { type: "footer", recordingEndedAt: Date.now(), eventCount: 2 },
    ];

    const validate = validatorFor("RecordingLine");
    for (const line of lines) {
      const ok = validate(JSON.parse(JSON.stringify(line)));
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    }
  });
});
