/**
 * ExportButton — triggers PDF or Word export of content via Electron IPC.
 *
 * Usage:
 *   <ExportButton format="pdf" content={htmlString} defaultName="Summary" />
 *   <ExportButton format="word" content={htmlString} defaultName="Analysis" />
 */

import React from "react";
import Icon from "./Icon";
import Tooltip from "./Tooltip";

interface Props {
  format: "pdf" | "word";
  content: string;
  defaultName: string;
  onExport?: () => void;
}

export default function ExportButton({ format, content, defaultName, onExport }: Props) {
  const handleExport = async () => {
    onExport?.();
    try {
      if (format === "pdf") {
        await window.electronAPI!.exportToPdf({
          html: content,
          defaultName: `${defaultName}.pdf`,
        });
      } else {
        await window.electronAPI!.exportToWord({
          html: content,
          defaultName: `${defaultName}.doc`,
        });
      }
    } catch (err: any) {
      console.error(`[ExportButton] Failed to export ${format}:`, err);
    }
  };

  const iconName = format === "pdf" ? "picture_as_pdf" : "description";
  const label = format === "pdf" ? "PDF" : "Word";
  const tooltip = `Export this tab's content as ${format === "pdf" ? "PDF" : "Word (.doc)"}`;

  return (
    <Tooltip content={tooltip}>
      <button className="rv-export-btn" onClick={handleExport} title={tooltip}>
        <Icon name={iconName} size="14" /> Export {label}
      </button>
    </Tooltip>
  );
}
