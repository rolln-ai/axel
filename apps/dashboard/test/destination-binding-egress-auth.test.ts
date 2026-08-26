import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  role: "owner" as "owner" | "admin" | "member",
  workspaceStatus: "active" as "active" | "suspended" | "deleted",
}));

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  decryptCredentialBlob: vi.fn(),
  pgPoolConstructor: vi.fn(),
  mongoClientConstructor: vi.fn(),
  sampleSourceEvents: vi.fn(),
  listPostgresTables: vi.fn(),
  listMongoCollections: vi.fn(),
  listDatabricksSqlTables: vi.fn(),
  listBigQueryTables: vi.fn(),
  listBigQueryDatasets: vi.fn(),
  listBigQueryTablesForDataset: vi.fn(),
  listBigQueryDatasetsForCredentials: vi.fn(),
  listBigQueryTablesForCredentials: vi.fn(),
  introspectBigQueryDestination: vi.fn(),
}));

vi.mock("../lib/session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: "user_1" },
    activeWorkspace: {
      workspace_id: "workspace_1",
      role: state.role,
      workspace_status: state.workspaceStatus,
    },
  })),
}));

vi.mock("../lib/db", () => ({
  db: () => ({ query: mocks.dbQuery }),
}));

vi.mock("../lib/credentials", () => ({
  credentialAad: vi.fn(() => "aad"),
  decryptCredentialBlob: mocks.decryptCredentialBlob,
}));

vi.mock("../lib/data-contracts/sampler", () => ({
  sampleSourceEvents: mocks.sampleSourceEvents,
}));

vi.mock("../lib/destination-inspect", () => ({
  CONNECTION_TIMEOUT_MS: 8_000,
  listPostgresTables: mocks.listPostgresTables,
  listMongoCollections: mocks.listMongoCollections,
  listDatabricksSqlTables: mocks.listDatabricksSqlTables,
  listBigQueryTables: mocks.listBigQueryTables,
  listBigQueryDatasets: mocks.listBigQueryDatasets,
  listBigQueryTablesForDataset: mocks.listBigQueryTablesForDataset,
  listBigQueryDatasetsForCredentials: mocks.listBigQueryDatasetsForCredentials,
  listBigQueryTablesForCredentials: mocks.listBigQueryTablesForCredentials,
  introspectBigQueryDestination: mocks.introspectBigQueryDestination,
}));

vi.mock("pg", () => ({
  Pool: class {
    constructor(...args: unknown[]) {
      mocks.pgPoolConstructor(...args);
    }

    query = vi.fn();
    end = vi.fn();
  },
}));

vi.mock("mongodb", () => ({
  MongoClient: class {
    constructor(...args: unknown[]) {
      mocks.mongoClientConstructor(...args);
    }

    connect = vi.fn();
    close = vi.fn();
    db = vi.fn();
  },
}));

import {
  checkBigQueryCompatibilityAction,
  createMongoCollection,
  createPostgresTable,
  createTableForConnection,
  listBigQueryDatasetsAction,
  listBigQueryTablesAction,
  listDestinationTargets,
  listTablesForConnection,
} from "../lib/destination-binding-actions";

const egressActions: Array<() => Promise<{ ok: boolean; error?: string }>> = [
  () => listDestinationTargets("destination_1"),
  () => listBigQueryDatasetsAction({ destinationId: "destination_1" }),
  () =>
    listBigQueryDatasetsAction({
      projectId: "project_1",
      serviceAccountJson: '{"private_key":"secret"}',
    }),
  () => listBigQueryTablesAction({ destinationId: "destination_1", dataset: "analytics" }),
  () =>
    listBigQueryTablesAction({
      projectId: "project_1",
      serviceAccountJson: '{"private_key":"secret"}',
      dataset: "analytics",
    }),
  () =>
    checkBigQueryCompatibilityAction({
      destinationId: "destination_1",
      table: "events",
      mode: "nested_records",
    }),
  () => createPostgresTable("destination_1", "events"),
  () => createMongoCollection("destination_1", "events"),
  () => listTablesForConnection("postgres", "postgres://user:pass@db.example/events"),
  () => listTablesForConnection("mongodb", "mongodb://user:pass@db.example/events", "events"),
  () => createTableForConnection("postgres", "postgres://user:pass@db.example/events", "events"),
  () =>
    createTableForConnection(
      "mongodb",
      "mongodb://user:pass@db.example/events",
      "events",
      "events",
    ),
];

function expectNoCredentialOrNetworkAccess(): void {
  expect(mocks.dbQuery).not.toHaveBeenCalled();
  expect(mocks.decryptCredentialBlob).not.toHaveBeenCalled();
  expect(mocks.sampleSourceEvents).not.toHaveBeenCalled();
  expect(mocks.pgPoolConstructor).not.toHaveBeenCalled();
  expect(mocks.mongoClientConstructor).not.toHaveBeenCalled();
  expect(mocks.listPostgresTables).not.toHaveBeenCalled();
  expect(mocks.listMongoCollections).not.toHaveBeenCalled();
  expect(mocks.listDatabricksSqlTables).not.toHaveBeenCalled();
  expect(mocks.listBigQueryTables).not.toHaveBeenCalled();
  expect(mocks.listBigQueryDatasets).not.toHaveBeenCalled();
  expect(mocks.listBigQueryTablesForDataset).not.toHaveBeenCalled();
  expect(mocks.listBigQueryDatasetsForCredentials).not.toHaveBeenCalled();
  expect(mocks.listBigQueryTablesForCredentials).not.toHaveBeenCalled();
  expect(mocks.introspectBigQueryDestination).not.toHaveBeenCalled();
}

describe("destination binding egress authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.role = "owner";
    state.workspaceStatus = "active";
  });

  it("rejects members before loading credentials or opening a connection", async () => {
    state.role = "member";

    for (const action of egressActions) {
      await expect(action()).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/only owners and admins/i),
      });
    }

    expectNoCredentialOrNetworkAccess();
  });

  it("rejects suspended workspaces before loading credentials or opening a connection", async () => {
    state.workspaceStatus = "suspended";

    for (const action of egressActions) {
      await expect(action()).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/workspace is suspended/i),
      });
    }

    expectNoCredentialOrNetworkAccess();
  });
});
