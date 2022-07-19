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
        core.debug(`Prior to core debug: ${this.issueKey}`);
        if (this.issueKey === '') {
            const issueKey = await this.getJiraIssueKeyFromUrl(this.jiraIssueUrl);
            this.issueKey = issueKey;
        }
        core.debug(`watchersUrl::issueKey ${this.issueKey}`);
        const bu = core.getInput("jiraBaseUrl");
        const fullWatchersUrl = `${bu}/rest/api/2/issue/${this.issueKey}/watchers`;
        core.debug(`Build full watchersUrl: ${fullWatchersUrl}`);
        return fullWatchersUrl;
    }
    async getJiraIssueWatchers() {
        const watchersUrl = await this.watchersUrl();
        const watcherResponse = await axios_1.default.get(watchersUrl, {
            headers: { Authorization: `Bearer ${this.botToken}` },
        });
        return watcherResponse.data.watchers.map(m => m.emailAddress);
    }
    async addRemoteWatcher(watcherEmail) {
        core.debug('JiraWatcherManager::addRemoteWatcher');
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
                .then(response => {
                resolve({
                    email: watcherEmail,
                    statusCode: response.status,
                    error: null,
                });
            })
                .catch(err => {
                reject({
                    email: watcherEmail,
                    statusCode: err.response.status,
                    error: err
                });
            });
        });
    }
    async deleteRemoteWatcher(watcherEmail) {
        core.info('JiraWatcherManager::deleteRemoteWatcher');
        var watchersUrl = "";
        try {
            watchersUrl = await this.watchersUrl();
            core.info(`Got watchers URL: ${watchersUrl}`);
        }
        catch (error) {
            var e = new Error();
            core.error(JSON.stringify(e.stack));
            core.info(`Error'd out while getting watchers url: ${JSON.stringify(error)}`);
        }
        watchersUrl = `${watchersUrl}?username=${watcherEmail}`;
        core.info(`deleteRemoteWatcher: ${watchersUrl}`);
        // Wrap error with email that failed so it can be reported by consumer
        return new Promise((resolve, reject) => {
            axios_1.default.delete(watchersUrl, {
                headers: {
                    'Authorization': `Bearer ${this.botToken}`,
                    'Content-Type': 'application/json',
                },
            })
                .then(response => {
                resolve({
                    email: watcherEmail,
                    statusCode: response.status,
                    error: null,
                });
            })
                .catch(err => {
                core.debug('Got internal delete response:');
                core.debug(`${watcherEmail},${err.response.status}, ${err.response.statusText}`);
                reject({
                    email: watcherEmail,
                    statusCode: err.response.status,
                    error: err
                });
            });
            // .then(() => resolve({email: watcherEmail, error: null}))
            // .catch(err => reject({email: watcherEmail, error: err}));
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
                core.info('Got results from core watcher fn');
                core.info(`${JSON.stringify(results)}`);
                // Annoyingly Typescript has no way to understand what's in the results
                // array, so this actually requires a cast
                const failures = results.filter(res => res.status === 'rejected');
                if (failures.length != 0) {
                    core.warning(`Failed to change ${failures.length} watcher(s), operating on list: ${JSON.stringify(_watcherEmails)}:`);
                    failures.forEach(err => core.error(JSON.stringify(err)));
                }
            };
        };
        core.info('watchers to add');
        await mutateWatchersFn(watchersToAdd, this.addRemoteWatcher)();
        core.info('watchers to delete');
        await mutateWatchersFn(watchersToDelete, this.deleteRemoteWatcher)();
    }
}
exports.JiraWatcherManager = JiraWatcherManager;
