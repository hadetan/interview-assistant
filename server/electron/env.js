const fs = require('node:fs');
const path = require('node:path');
const { config: dotenvConfig } = require('dotenv');

const normalizeFlagValue = (value) => {
    if (value === undefined || value === null) {
        return '';
    }
    return String(value).trim().toLowerCase();
};

const parseArgvFlags = (argv = process.argv.slice(1)) => (argv || []).map((arg) => normalizeFlagValue(arg));

const isTruthyFlag = (value) => {
    const normalized = normalizeFlagValue(value);
    if (!normalized) {
        return false;
    }
    return !['0', 'false', 'off', 'no'].includes(normalized);
};

const hasArgFlag = (argvFlags = [], ...candidates) => {
    if (!Array.isArray(argvFlags) || !argvFlags.length || !candidates.length) {
        return false;
    }
    const normalizedArgs = argvFlags.map((arg) => normalizeFlagValue(arg));
    return candidates.some((candidate) => normalizedArgs.includes(normalizeFlagValue(candidate)));
};

const offModeActive = (env = process.env, argvFlags = parseArgvFlags()) => {
    return isTruthyFlag(env?.OFF) || hasArgFlag(argvFlags, 'off', '--off');
};

const shouldDisableContentProtection = (env = process.env, argvFlags = parseArgvFlags()) => {
    if (offModeActive(env, argvFlags)) {
        return true;
    }
    if (isTruthyFlag(env?.NO_CONTENT_PROTECTION)) {
        return true;
    }
    return hasArgFlag(argvFlags, '--no-content-protection', 'no-content-protection');
};

const loadEnv = ({
    processRef = process,
    fsModule = fs,
    pathModule = path,
    dotenv = dotenvConfig
} = {}) => {
    try {
        const cwd = typeof processRef.cwd === 'function' ? processRef.cwd() : process.cwd();
        const resourcesBase = processRef.resourcesPath || cwd;
        const resourcesEnvPath = pathModule.join(resourcesBase, '.env');
        if (fsModule.existsSync(resourcesEnvPath)) {
            dotenv({ path: resourcesEnvPath });
            console.log('[Main] Loaded environment from resources .env');
        } else {
            dotenv();
            console.log('[Main] Loaded environment from project .env (if present)');
        }
    } catch (_err) {
        // ensure we fallback silently in dev
        dotenv();
    }
};

module.exports = {
    loadEnv,
    normalizeFlagValue,
    parseArgvFlags,
    isTruthyFlag,
    hasArgFlag,
    offModeActive,
    shouldDisableContentProtection
};
