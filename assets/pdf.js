/* 极简 PDF 生成器：把一张 JPEG 图片嵌入为单页 PDF（页幅 = 图片尺寸） */
(function (root) {
  'use strict';

  function fmt(n) {
    return String(Math.round(n * 100) / 100);
  }

  function buildPdfBytes(jpegBytes, imgW, imgH, pageW, pageH) {
    const encoder = new TextEncoder();
    const parts = [];
    const offsets = [];
    let size = 0;

    function push(data) {
      const bytes = typeof data === 'string' ? encoder.encode(data) : data;
      parts.push(bytes);
      size += bytes.length;
    }

    function obj(num, dict, stream) {
      offsets[num] = size;
      push(num + ' 0 obj\n');
      push(dict + '\n');
      if (stream) {
        push('stream\n');
        push(stream);
        push('\nendstream\n');
      }
      push('endobj\n');
    }

    push('%PDF-1.4\n');
    // 二进制标记，避免文件被当作纯文本处理
    push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + fmt(pageW) + ' ' + fmt(pageH) +
      '] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>');
    obj(4, '<< /Type /XObject /Subtype /Image /Width ' + imgW + ' /Height ' + imgH +
      ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
      jpegBytes.length + ' >>', jpegBytes);

    const content = 'q\n' + fmt(pageW) + ' 0 0 ' + fmt(pageH) + ' 0 0 cm\n/Im0 Do\nQ\n';
    const contentBytes = encoder.encode(content);
    obj(5, '<< /Length ' + contentBytes.length + ' >>', contentBytes);

    const xrefOffset = size;
    push('xref\n0 6\n');
    push('0000000000 65535 f \n');
    for (let i = 1; i <= 5; i++) {
      push(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
    }
    push('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF\n');

    const out = new Uint8Array(size);
    let pos = 0;
    parts.forEach(function (p) {
      out.set(p, pos);
      pos += p.length;
    });
    return out;
  }

  root.buildPdfBytes = buildPdfBytes;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildPdfBytes: buildPdfBytes };
  }
})(typeof window !== 'undefined' ? window : globalThis);
