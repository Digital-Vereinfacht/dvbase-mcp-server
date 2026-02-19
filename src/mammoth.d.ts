declare module "mammoth" {
  interface MammothMessage {
    type: string;
    message: string;
  }
  interface MammothResult {
    value: string;
    messages: MammothMessage[];
  }
  interface MammothInput {
    buffer: Buffer;
  }
  function extractRawText(input: MammothInput): Promise<MammothResult>;
  function convertToHtml(input: MammothInput): Promise<MammothResult>;
  export default { extractRawText, convertToHtml };
}
