import { initAuthCreds, BufferJSON, proto, AuthenticationState, SignalDataTypeMap } from 'baileys';
import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';

export async function useCustomFileAuthState(churchId: string, baseDir: string): Promise<{ state: AuthenticationState, saveCreds: () => Promise<void> }> {
    const dir = path.join(baseDir, churchId);

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    const getFile = (file: string) => path.join(dir, file);

    // In-memory cache for keys to reduce filesystem reads
    const cache = new Map<string, any>();

    const readData = async (file: string) => {
        if (cache.has(file)) return cache.get(file);
        try {
            const data = await fs.readFile(getFile(file), { encoding: 'utf-8' });
            const parsed = JSON.parse(data, BufferJSON.reviver);
            cache.set(file, parsed);
            return parsed;
        } catch {
            return null;
        }
    };

    const writeData = async (data: any, file: string) => {
        cache.set(file, data);
        try {
            await fs.writeFile(getFile(file), JSON.stringify(data, BufferJSON.replacer));
        } catch (error) {
            console.error(`Error saving auth file ${file}:`, error);
        }
    };

    const removeData = async (file: string) => {
        cache.delete(file);
        try {
            await fs.unlink(getFile(file));
        } catch { }
    };

    const fixFileName = (file?: string) => file?.replace(/\//g, '__')?.replace(/:/g, '-');

    const creds = await readData('creds.json') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data: { [_: string]: SignalDataTypeMap[typeof type] } = {};
                    await Promise.all(
                        ids.map(async id => {
                            let value = await readData(`${type}-${fixFileName(id)}.json`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.create(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data: any) => {
                    const tasks: Promise<void>[] = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const file = `${category}-${fixFileName(id)}.json`;
                            if (value) {
                                tasks.push(writeData(value, file));
                            } else {
                                tasks.push(removeData(file));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds.json')
    };
}

export async function clearSession(churchId: string, baseDir: string) {
    const dir = path.join(baseDir, churchId);
    try {
        await fs.rm(dir, { recursive: true, force: true });
    } catch { }
}
