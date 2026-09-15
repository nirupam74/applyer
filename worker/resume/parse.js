import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// bytesToText(bytes, mime) -> string. Throws Error('Unsupported file type') for anything else.
export async function bytesToText(bytes, mime) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (mime === 'application/pdf') {
    const { text } = await pdfParse(buf);
    return text;
  }
  if (mime === DOCX_MIME) {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value;
  }
  if (mime === 'text/plain') {
    return buf.toString('utf8');
  }
  throw new Error('Unsupported file type');
}
