declare module "parquetjs-lite" {
  import type { Writable } from "node:stream";

  export interface ParquetFieldDefinition {
    type: string;
    optional?: boolean;
    repeated?: boolean;
    encoding?: string;
    compression?: string;
    /** Set false to skip writing column statistics. parquetjs-lite's reader
     *  throws decoding TIMESTAMP_MILLIS stats (BigInt→number), so timestamp
     *  columns must opt out to stay round-trippable. */
    statistics?: boolean;
    fields?: Record<string, ParquetFieldDefinition>;
  }

  export class ParquetSchema {
    constructor(schema: Record<string, ParquetFieldDefinition>);
  }

  export class ParquetWriter {
    static openStream(
      schema: ParquetSchema,
      outputStream: Writable,
      opts?: Record<string, unknown>,
    ): Promise<ParquetWriter>;
    appendRow(row: Record<string, unknown>): Promise<void>;
    close(): Promise<void>;
    setMetadata(key: string, value: string): void;
  }

  export interface ParquetCursor {
    next(): Promise<Record<string, unknown> | null>;
  }

  export class ParquetReader {
    static openBuffer(buffer: Buffer): Promise<ParquetReader>;
    getCursor(): ParquetCursor;
    getRowCount(): number;
    close(): Promise<void>;
  }
}
