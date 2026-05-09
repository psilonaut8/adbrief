// Parse various file types to plain text for use as AI context

async function parseContextFile(buffer, filename, mimetype) {
  const ext = (filename || '').split('.').pop().toLowerCase();

  // Markdown and plain text — read directly
  if (['md', 'txt', 'text', 'csv'].includes(ext) || /text\//.test(mimetype)) {
    return buffer.toString('utf8').trim();
  }

  // JSON — pretty-print so the AI can read it naturally
  if (ext === 'json' || /application\/json/.test(mimetype)) {
    try {
      return JSON.stringify(JSON.parse(buffer.toString('utf8')), null, 2);
    } catch {
      return buffer.toString('utf8').trim();
    }
  }

  // Word documents
  if (ext === 'docx' || /wordprocessingml|msword/.test(mimetype)) {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value.trim();
  }

  // PDFs
  if (ext === 'pdf' || /application\/pdf/.test(mimetype)) {
    const pdfParse = require('pdf-parse');
    const result = await pdfParse(buffer);
    return result.text.trim();
  }

  // Fallback: try as UTF-8 text
  const text = buffer.toString('utf8').trim();
  if (text && !/[\x00-\x08\x0E-\x1F]/.test(text.slice(0, 200))) return text;

  throw new Error(`Unsupported file type: .${ext}`);
}

module.exports = { parseContextFile };
