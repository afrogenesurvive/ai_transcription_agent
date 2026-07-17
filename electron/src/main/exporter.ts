/**
 * Exporter — IPC handlers for PDF and Word document export.
 *
 * PDF:  Generates an HTML page → loads in a hidden BrowserWindow → printToPDF() → save dialog
 * Word: Generates an HTML page → save dialog → writes as .doc (Word renders HTML natively)
 */

import { BrowserWindow, dialog, ipcMain } from "electron";
import fs from "fs";
import path from "path";

const EXPORT_WIDTH = 800;
const EXPORT_HEIGHT = 600;

/**
 * Build a complete styled HTML document from content body.
 * Uses a clean print-friendly stylesheet for consistent PDF/Word output.
 */
function buildExportHtml(bodyHtml: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  @page { margin: 20mm 15mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.6;
    color: #1a1a1a;
    max-width: 700px;
    margin: 0 auto;
    padding: 20px;
  }
  h1 { font-size: 18pt; margin-bottom: 12px; color: #111; }
  h2 { font-size: 14pt; margin-top: 20px; margin-bottom: 8px; color: #333; }
  h3 { font-size: 12pt; margin-top: 16px; margin-bottom: 6px; color: #444; }
  p { margin-bottom: 8px; }
  ul, ol { margin: 4px 0 12px 20px; }
  li { margin-bottom: 4px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; font-size: 10pt; }
  th { background: #f5f5f5; font-weight: 600; }
  .meta { color: #666; font-size: 10pt; margin-bottom: 16px; }
  .tag {
    display: inline-block; background: #e8e8e8; border-radius: 3px;
    padding: 2px 8px; margin: 2px 4px 2px 0; font-size: 9pt;
  }
  .section { margin-bottom: 20px; }
  .badge {
    display: inline-block; border-radius: 3px; padding: 1px 8px;
    font-size: 9pt; font-weight: 500;
  }
  .badge--vp { background: #d4edda; color: #155724; }
  .badge--no-vp { background: #f8f9fa; color: #6c757d; }
  .badge--delivered { background: #cce5ff; color: #004085; }
  .badge--no-delivery { background: #fff3cd; color: #856404; }
  hr { border: none; border-top: 1px solid #ddd; margin: 20px 0; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function registerExportHandlers(getMainWindow: () => BrowserWindow | null): void {
  // ── Export to PDF ──
  ipcMain.handle("export:pdf", async (_event, params: { html: string; defaultName?: string }) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return { success: false, error: "No main window available" };

    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export as PDF",
      defaultPath: params.defaultName || "export.pdf",
      filters: [{ name: "PDF Documents", extensions: ["pdf"] }],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, cancelled: true };
    }

    // Create a hidden window to render the HTML and generate PDF
    const exportWindow = new BrowserWindow({
      width: EXPORT_WIDTH,
      height: EXPORT_HEIGHT,
      show: false,
      webPreferences: {
        javascript: false,
        images: false,
        sandbox: true,
      },
    });

    try {
      const fullHtml = buildExportHtml(params.html, "Meeting Summary");

      // Write HTML to a temp file and load it (avoids encoding issues with data URIs)
      const tmpFile = path.join(require("os").tmpdir(), `export-${Date.now()}.html`);
      fs.writeFileSync(tmpFile, fullHtml, "utf8");

      await exportWindow.loadFile(tmpFile);

      const pdfData = await exportWindow.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      });

      fs.writeFileSync(result.filePath, pdfData);

      // Clean up temp file
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }

      return { success: true, filePath: result.filePath };
    } catch (err: any) {
      return { success: false, error: err.message };
    } finally {
      if (!exportWindow.isDestroyed()) {
        exportWindow.close();
      }
    }
  });

  // ── Export to Word (.doc — saved as HTML with .doc extension) ──
  ipcMain.handle("export:word", async (_event, params: { html: string; defaultName?: string }) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return { success: false, error: "No main window available" };

    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export as Word Document",
      defaultPath: params.defaultName || "export.doc",
      filters: [{ name: "Word Documents", extensions: ["doc"] }],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, cancelled: true };
    }

    try {
      const fullHtml = buildExportHtml(params.html, "Meeting Summary");

      // Write as .doc — Word opens HTML files saved with .doc extension natively
      // Add XML declaration and Office-compatible meta for best compatibility
      const docContent = `\uFEFF<html xmlns:o="urn:schemas-microsoft-com:office:office"
xmlns:w="urn:schemas-microsoft-com:office:word"
xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>Meeting Summary</title></head>
<body>
${params.html}
</body>
</html>`;

      fs.writeFileSync(result.filePath, docContent, "utf8");

      return { success: true, filePath: result.filePath };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
}
