/*
 * ExportPanel: the "Export" section of /admin. Lists every file from GET /api/admin/export
 * (name, description, row count) with a Download link, plus "Download all CSVs".
 * If the index call fails it falls back to the 7 known names with links and no counts.
 *
 * CSS classes (existing ones are styled in src/styles/global.css; the new ones are optional
 * hooks and the panel reads fine unstyled):
 *   .admin__section           section wrapper (existing)
 *   .admin__section-title     h2 (existing)
 *   .admin__table-wrap        scroll wrapper (existing)
 *   .admin__table             the export table (existing)
 *   .admin__export-link       Download link, styled as a button (existing)
 *   .admin__actions           row holding "Download all CSVs" + checkbox (existing)
 *   .admin__button            "Download all CSVs" (existing)
 *   .admin__checkbox          "Include raw JSON" label (existing)
 *   .admin__notice            fallback / progress line (existing)
 *   .admin__export            one export row (new, optional)
 *   .admin__export--featured  highlighted row: participants.csv, kpis.csv (new, optional)
 *   .admin__export-name       file name cell (new, optional)
 *   .admin__export-badge      "Start here …" / "Dashboard numbers" tag (new, optional; rendered as <strong>)
 *   .admin__export-rows       row count cell (new, optional)
 */
import { useEffect, useRef, useState } from "react";
import { api, EXPORT_NAMES, type ExportIndexEntry, type ExportName } from "../api/client";

export const DOWNLOAD_GAP_MS = 300;

const BADGES: Partial<Record<ExportName, string>> = {
  "participants.csv": "Start here — one row per session",
  "kpis.csv": "Dashboard numbers",
};

const RAW_JSON: ExportName = "sessions.json";

interface Row {
  name: ExportName;
  description: string | null;
  rows: number | null;
}

const FALLBACK_ROWS: Row[] = EXPORT_NAMES.map((name) => ({ name, description: null, rows: null }));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function triggerDownload(name: ExportName) {
  const a = document.createElement("a");
  a.href = api.admin.exportUrl(name);
  a.download = name;
  a.hidden = true;
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
  }
}

export default function ExportPanel({ refreshKey }: { refreshKey?: number | string }) {
  const [index, setIndex] = useState<ExportIndexEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [includeJson, setIncludeJson] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => api.admin.getExportIndex())
      .then((list) => {
        if (cancelled) return;
        setIndex(Array.isArray(list) ? list : null);
        setFailed(!Array.isArray(list));
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const rows: Row[] = index && !failed ? index : FALLBACK_ROWS;

  async function downloadAll() {
    const names = rows
      .map((r) => r.name)
      .filter((n) => n.endsWith(".csv") || (includeJson && n === RAW_JSON));
    for (let i = 0; i < names.length; i++) {
      if (!alive.current) return;
      if (i > 0) await sleep(DOWNLOAD_GAP_MS);
      if (!alive.current) return;
      setDownloading(`Downloading ${names[i]} (${i + 1} of ${names.length})…`);
      triggerDownload(names[i]);
    }
    if (alive.current) setDownloading(null);
  }

  return (
    <section className="admin__section" aria-labelledby="admin-export-title">
      <h2 id="admin-export-title" className="admin__section-title">Export</h2>
      {failed && (
        <p className="admin__notice" role="status">
          Could not load the export list; row counts are unavailable. The download links still work.
        </p>
      )}
      <div className="admin__table-wrap">
        <table className="admin__table admin__exports-table" aria-label="Exports">
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Description</th>
              <th scope="col">Rows</th>
              <th scope="col">Download</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const badge = BADGES[r.name];
              return (
                <tr
                  key={r.name}
                  className={`admin__export${badge ? " admin__export--featured" : ""}`}
                  data-testid={`export-${r.name}`}
                >
                  <th scope="row" className="admin__export-name">
                    <code>{r.name}</code>
                    {badge && (
                      <>
                        {" "}
                        <strong className="admin__export-badge">{badge}</strong>
                      </>
                    )}
                  </th>
                  <td>{r.description ?? "—"}</td>
                  <td className="admin__export-rows">{r.rows == null ? "—" : r.rows}</td>
                  <td>
                    <a
                      className="admin__export-link"
                      href={api.admin.exportUrl(r.name)}
                      download={r.name}
                      aria-label={`Download ${r.name}`}
                    >
                      Download
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="admin__actions">
        <button
          type="button"
          className="admin__button admin__button--primary"
          onClick={() => void downloadAll()}
          disabled={downloading !== null}
        >
          Download all CSVs
        </button>
        <label className="admin__checkbox">
          <input type="checkbox" checked={includeJson} onChange={(e) => setIncludeJson(e.target.checked)} />
          Include raw JSON (sessions.json)
        </label>
      </div>
      {downloading && (
        <p className="admin__notice" aria-live="polite">
          {downloading}
        </p>
      )}
    </section>
  );
}
