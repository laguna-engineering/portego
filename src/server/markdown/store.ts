import type { Database } from "bun:sqlite";

export type CachedMarkdown = {
  markdown: string;
  empty: boolean;
  /** `provided` is authored Markdown. `generated` is converted from HTML. */
  source: "provided" | "generated";
  converterVersion: string;
  generatedAt: Date;
};

export type MarkdownStore = {
  /** A conversion of this exact source by this exact converter, if there is one. */
  read: (
    versionId: string,
    sourceSha256: string,
    converterVersion: string,
  ) => CachedMarkdown | null;
  write: (input: {
    versionId: string;
    sourceSha256: string;
    converterVersion: string;
    markdown: string;
    empty: boolean;
  }) => CachedMarkdown;
  /** Markdown supplied when this version was uploaded, if any. */
  readProvided: (versionId: string) => CachedMarkdown | null;
};

type Row = {
  markdown: string;
  isEmpty: number;
  converterVersion: string;
  generatedAt: number;
};

/**
 * Converted Markdown, kept so a large document is parsed once. The stored
 * digest and converter version are part of the lookup, so a new converter or a
 * different source never serves a stale conversion.
 */
export function createMarkdownStore(options: { database: Database }): MarkdownStore {
  const { database } = options;

  return {
    read(versionId, sourceSha256, converterVersion) {
      const row = database
        .query(
          `select markdown, isEmpty, converterVersion, generatedAt from artifactMarkdown
           where versionId = ? and sourceSha256 = ? and converterVersion = ?`,
        )
        .get(versionId, sourceSha256, converterVersion) as Row | null;
      if (!row) return null;
      return {
        markdown: row.markdown,
        empty: row.isEmpty === 1,
        source: "generated",
        converterVersion: row.converterVersion,
        generatedAt: new Date(row.generatedAt),
      };
    },

    write(input) {
      const generatedAt = Date.now();
      database
        .query(
          `insert into artifactMarkdown
             (versionId, converterVersion, sourceSha256, markdown, isEmpty, generatedAt)
           values (?, ?, ?, ?, ?, ?)
           on conflict (versionId) do update set
             converterVersion = excluded.converterVersion,
             sourceSha256 = excluded.sourceSha256,
             markdown = excluded.markdown,
             isEmpty = excluded.isEmpty,
             generatedAt = excluded.generatedAt`,
        )
        .run(
          input.versionId,
          input.converterVersion,
          input.sourceSha256,
          input.markdown,
          input.empty ? 1 : 0,
          generatedAt,
        );
      return {
        markdown: input.markdown,
        empty: input.empty,
        source: "generated",
        converterVersion: input.converterVersion,
        generatedAt: new Date(generatedAt),
      };
    },

    readProvided(versionId) {
      const row = database
        .query(
          `select markdown, isEmpty, converterVersion, generatedAt from artifactMarkdown
           where versionId = ? and converterVersion = 'provided'`,
        )
        .get(versionId) as Row | null;
      if (!row) return null;
      return {
        markdown: row.markdown,
        empty: row.isEmpty === 1,
        source: "provided",
        converterVersion: row.converterVersion,
        generatedAt: new Date(row.generatedAt),
      };
    },
  };
}
