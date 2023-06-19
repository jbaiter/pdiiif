import { PdfValueParser } from '../pdf/parser';
import { textEncoder } from '../pdf/util';
import { PdfRef } from '../pdf/common';

const FIXTURES = {
  dict: `
    <<
      /TrueBool true
      /FalseBool false
      /NullValue null
      /Integer -20
      /Real -13.137
      /String (Hello World)
      /HexString <1337DEADBEEF>
      /Ref 13 0 R
      /Array [1 (Foo) <C0FFEF>]
      /Nested << /Hello (World) >>
    >>`,
  specialString: '(One (\\0433)\\)\\n\\r)',
};

describe('The PDF object value parser', () => {
  it('should correctly parse a string literal with nested parentheses and escaped characters', () => {
    const parser = new PdfValueParser(textEncoder.encode(FIXTURES.specialString));
    expect(parser.read()).toEqual('One (#3))\n\r');
  });
  it('should correctly parse a dictionary with all types', () => {
    const parser = new PdfValueParser(textEncoder.encode(FIXTURES.dict));
    const value = parser.read();
    expect(value).toMatchObject({
      TrueBool: true,
      FalseBool: false,
      Integer: -20,
      Real: -13.137,
      String: 'Hello World',
      HexString: new Uint8Array([0x13, 0x37, 0xde, 0xad, 0xbe, 0xef]),
      Ref: new PdfRef(13),
      Array: [1, 'Foo', new Uint8Array([0xc0, 0xff, 0xef])],
      Nested: { Hello: 'World' },
    });
  });
});
