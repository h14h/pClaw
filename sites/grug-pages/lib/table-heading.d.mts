export type HeadingRun = { text: string; nowrap: boolean };

export declare const HEADING_ONE_LINE_MAX: number;
export declare const HEADING_TWO_LINE_MAX: number;
export declare function splitKeepingHyphenated(value: string): HeadingRun[];
export declare function planTableHeading(rawText: string): { oneLine: boolean; runs: HeadingRun[] };
