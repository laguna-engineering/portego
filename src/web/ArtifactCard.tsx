import type { Artifact } from "./api.ts";
import { excerpt, formatBytes } from "./format.ts";
import { RelativeTime } from "./RelativeTime.tsx";
import { fullScreenPath } from "./router.ts";

export type ArtifactCardProps = { artifact: Artifact; onOpen: (id: string) => void };

/**
 * A stable pair of hues for one artifact. The card shows a generated mark
 * rather than a rendering of the upload: no artifact markup enters this DOM.
 */
function hues(id: string): [number, number] {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) % 360;
  return [hash, (hash + 47) % 360];
}

export function ArtifactCard({ artifact, onOpen }: ArtifactCardProps) {
  const [from, to] = hues(artifact.id);

  return (
    <li className="card">
      <a
        className="card-link"
        href={fullScreenPath(artifact.id)}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          onOpen(artifact.id);
        }}
      >
        <span
          className="card-mark"
          aria-hidden="true"
          style={{
            background: `linear-gradient(135deg, oklch(0.72 0.15 ${from}), oklch(0.55 0.17 ${to}))`,
          }}
        >
          {artifact.title.slice(0, 2).toUpperCase()}
        </span>
        <span className="card-body">
          <span className="card-title">
            {artifact.title}
            {artifact.versionCount > 1 ? (
              <span className="badge">v{artifact.versionCount}</span>
            ) : null}
            {artifact.status === "solved" ? <span className="badge solved">solved</span> : null}
            {artifact.archivedAt ? <span className="badge">archived</span> : null}
          </span>
          {artifact.description ? (
            <span className="card-description">{excerpt(artifact.description, 110)}</span>
          ) : null}
          <span className="card-meta">
            {artifact.creator.name} · created <RelativeTime iso={artifact.createdAt} />
            {artifact.updatedAt !== artifact.createdAt ? (
              <>
                {" "}
                · updated <RelativeTime iso={artifact.updatedAt} />
              </>
            ) : null}{" "}
            · {formatBytes(artifact.byteSize)}
          </span>
        </span>
      </a>
    </li>
  );
}
