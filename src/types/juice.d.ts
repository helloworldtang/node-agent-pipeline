// juice 11 没有随包发布 .d.ts，这里给出用到的最小类型声明（仅供 tsc 类型检查；运行由 Node 类型剥离直接执行）
declare module "juice" {
  export interface JuiceOptions {
    inlinePseudoElements?: boolean;
    preserveImportant?: boolean;
    applyStyleTags?: boolean;
    removeStyleTags?: boolean | string;
    preserveMediaQueries?: boolean;
    preserveFontFaces?: boolean;
    preserveKeyFrames?: boolean;
    applyWidthAttributes?: boolean;
    applyHeightAttributes?: boolean;
    xmlMode?: boolean;
    extraCss?: string;
  }
  export function inlineContent(html: string, css: string, options?: JuiceOptions): string;
  export function inlineFile(filename: string, options?: JuiceOptions): string;
  const juice: {
    inlineContent: typeof inlineContent;
    inlineFile: typeof inlineFile;
    [key: string]: unknown;
  };
  export default juice;
}
