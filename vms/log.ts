import BN from "bn.js";

export default class Log {
    chain: string

    constructor(chain: string) {
        this.chain = chain
    }

    info(message: string, data?: any) {
        this.logWithFunction(console.log, 'info', message, data);
    }

    warn(message: string, data?: any) {
        this.logWithFunction(console.warn, 'warn', message, data);
    }

    error(message: string, data?: any) {
        this.logWithFunction(console.error, 'error', message, data);
    }

    logWithFunction(
      logFn: (...contents: any[]) => void,
      level: string,
      message: string,
      data?: any,
    ) {
        const fullLog = {
            timestamp: new Date().toISOString(),
            level,
            message,
            data: stringifySubfields(data),
        };
        logFn(JSON.stringify(fullLog));
    }
}

function stringifySubfields(input: any): any {
    if (input instanceof BN) {
        return input.toString();
    }
    if (Array.isArray(input)) {
        return input.map(stringifySubfields);
    }
    if (input !== null && typeof input === 'object') {
        const output: any = {};
        for (const key in input) {
            output[key] = stringifySubfields(input[key]);
        }
        return output;
    }
    return input;
}