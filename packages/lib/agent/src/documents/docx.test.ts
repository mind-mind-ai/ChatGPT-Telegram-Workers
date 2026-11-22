import { strToU8, zipSync } from 'fflate';
import { parseDocx } from './docx';

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Introduction</w:t></w:r></w:p>
    <w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>&amp; world</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>First item</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Details</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
  </w:body>
</w:document>`;

const STYLES_XML = `<?xml version="1.0"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
</w:styles>`;

function makeDocx(documentXml = DOCUMENT_XML, stylesXml: string | undefined = STYLES_XML): Uint8Array {
    const entries: Record<string, Uint8Array> = {
        '[Content_Types].xml': strToU8('<Types/>'),
        'word/document.xml': strToU8(documentXml),
    };
    if (stylesXml) {
        entries['word/styles.xml'] = strToU8(stylesXml);
    }
    return zipSync(entries);
}

describe('parseDocx', () => {
    it('extracts headings, paragraphs, lists and table cells', async () => {
        const document = await parseDocx(makeDocx(), 'sample.docx');

        expect(document.kind).toBe('docx');
        expect(document.needsOcr).toBe(false);
        const text = document.pages.map(page => page.text).join('\n');
        expect(text).toContain('# Introduction');
        expect(text).toContain('Hello & world');
        expect(text).toContain('- First item');
        expect(text).toContain('## Details');
        expect(text).toContain('Cell A');
        expect(text).toContain('Cell B');
        expect(document.pages[0].headingPath).toEqual(['Introduction']);
    });

    it('rejects a non-ZIP file', async () => {
        await expect(parseDocx(new Uint8Array([1, 2, 3]), 'fake.docx')).rejects.toMatchObject({
            code: 'unsupported',
        });
    });

    it('rejects a ZIP without word/document.xml', async () => {
        const archive = zipSync({ '[Content_Types].xml': strToU8('<Types/>') });
        await expect(parseDocx(archive, 'fake.docx')).rejects.toMatchObject({ code: 'parse' });
    });

    it('enforces the entry count limit before extraction', async () => {
        const entries: Record<string, Uint8Array> = {
            '[Content_Types].xml': strToU8('<Types/>'),
            'word/document.xml': strToU8(DOCUMENT_XML),
        };
        for (let i = 0; i < 1000; i++) {
            entries[`word/extra-${i}.xml`] = strToU8('');
        }
        const archive = zipSync(entries);
        await expect(parseDocx(archive, 'bomb.docx')).rejects.toMatchObject({ code: 'too-large' });
    });

    it('marks a DOCX without extractable text as needing OCR', async () => {
        const emptyXml = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body></w:body></w:document>';
        const document = await parseDocx(makeDocx(emptyXml, undefined), 'empty.docx');
        expect(document.needsOcr).toBe(true);
        expect(document.pages[0].text).toBe('');
    });
});
