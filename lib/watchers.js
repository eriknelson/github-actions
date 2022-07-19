"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JiraWatcherManager = void 0;
const core = __importStar(require("@actions/core"));
const axios_1 = __importDefault(require("axios"));
class JiraWatcherManager {
    constructor(jiraIssueUrl, botToken) {
        const addWatchers = core.getInput('addWatchers');
        core.debug(`Raw addWatchers: "${addWatchers}"`);
        this.addWatchers = addWatchers ?
            addWatchers.split(',') : [];
        const removeWatchers = core.getInput('removeWatchers');
        core.debug(`Raw removeWatchers: "${removeWatchers}"`);
        this.removeWatchers = removeWatchers ?
            removeWatchers.split(',') : [];
        this.jiraIssueUrl = jiraIssueUrl;
        this.botToken = botToken;
        this.issueKey = '';
    }
    async getJiraIssueKeyFromUrl(url) {
        const issueInfoUrl = `${url}?fields=key`;
        core.info(`Info url: ${issueInfoUrl}`);
        const { data: { key }, } = await axios_1.default.get(issueInfoUrl, {
            headers: { Authorization: `Bearer ${this.botToken}` },
        });
        return key;
    }
    async watchersUrl() {
        if (this.issueKey == '') {
            const issueKey = await this.getJiraIssueKeyFromUrl(this.jiraIssueUrl);
            this.issueKey = issueKey;
        }
        const bu = core.getInput("jiraBaseUrl");
        return `${bu}/rest/api/2/issue/${this.issueKey}/watchers`;
    }
    async getJiraIssueWatchers() {
        const watchersUrl = await this.watchersUrl();
        const watcherResponse = await axios_1.default.get(watchersUrl, {
            headers: { Authorization: `Bearer ${this.botToken}` },
        });
        return watcherResponse.data.watchers.map(m => m.emailAddress);
    }
    async setRemoteWatcher(watcherEmail) {
        const watchersUrl = await this.watchersUrl();
        const reqBody = `"${watcherEmail}"`;
        // Wrap error with email that failed so it can be reported by consumer
        return new Promise((resolve, reject) => {
            axios_1.default.post(watchersUrl, reqBody, {
                headers: {
                    'Authorization': `Bearer ${this.botToken}`,
                    'Content-Type': 'application/json',
                },
            })
                .then(() => resolve({ email: watcherEmail, error: null }))
                .catch(err => reject({ email: watcherEmail, error: err }));
        });
    }
    async deleteRemoteWatcher(watcherEmail) {
        var watchersUrl = await this.watchersUrl();
        watchersUrl = `${watchersUrl}?username=${watcherEmail}`;
        // Wrap error with email that failed so it can be reported by consumer
        return new Promise((resolve, reject) => {
            axios_1.default.delete(watchersUrl, {
                headers: {
                    'Authorization': `Bearer ${this.botToken}`,
                    'Content-Type': 'application/json',
                },
            })
                .then(() => resolve({ email: watcherEmail, error: null }))
                .catch(err => reject({ email: watcherEmail, error: err }));
        });
    }
    async ensureDesiredWatchers() {
        if (this.addWatchers.length === 0) {
            core.info('No desired watchers have been configured and none will be added');
            return;
        }
        core.debug('Ensuring desired watchers');
        core.debug(JSON.stringify(this.addWatchers));
        core.debug(JSON.stringify(this.removeWatchers));
        const currentWatchers = await this.getJiraIssueWatchers();
        core.debug('Current watcher list:');
        core.debug(JSON.stringify(currentWatchers));
        const watchersToAdd = this.addWatchers.reduce((toAdd, d) => {
            return currentWatchers.includes(d) ? toAdd : [...toAdd, d];
        }, []);
        const watchersToDelete = this.removeWatchers.reduce((toDelete, d) => {
            return currentWatchers.includes(d) ? [...toDelete, d] : toDelete;
        }, []);
        core.info('Adding missing watchers:');
        core.info(JSON.stringify(watchersToAdd));
        core.info('Removing watchers that should not be present:');
        core.info(JSON.stringify(watchersToDelete));
        const mutateWatchersFn = (_watcherEmails, mutationFn) => {
            return async () => {
                // Send independent watch requests in parallel. We don't care if some
                // fail because none of the requests depend upon one another. Gate on
                // all requests concluding with Promise.allSettled, and parse the results.
                // The "Add Watcher" endpoint returns nothing; it just indicates the result
                // via status code.
                // I've seen several possible:
                // 204 - It's present -- no indication if it wasn't there already, idempotent
                // 400 - These are thrown for some reason if someone doesn't have privileges
                // and often there's very little information (if any) about why
                // 404 - Just a bad URL
                // 415 - Missing Content-Type header
                // Delete watchers is a simple delete call with the username as a q param
                const results = await Promise.allSettled(_watcherEmails.map(email => mutationFn(email)));
                // Annoyingly Typescript has no way to understand what's in the results
                // array, so this actually requires a cast
                const failures = results.filter(res => res.status === 'rejected');
                if (failures.length != 0) {
                    core.warning(`Failed to change ${failures.length} watcher(s), operating on list: ${JSON.stringify(_watcherEmails)}:`);
                    failures.forEach(err => core.error(JSON.stringify(err)));
                }
            };
        };
        await mutateWatchersFn(watchersToAdd, this.setRemoteWatcher)();
        await mutateWatchersFn(watchersToDelete, this.deleteRemoteWatcher)();
    }
}
exports.JiraWatcherManager = JiraWatcherManager;
