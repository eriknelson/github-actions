import * as core from '@actions/core';
import axios from 'axios';
  
type RemoteWatcherResult = {
  email: string;
  statusCode: number;
  error: any;
};

class JiraWatcherManager {
  private jiraIssueUrl: string;
  private botToken: string;
  private issueKey: string;
  private addWatchers: string[];
  private removeWatchers: string[];

  constructor(jiraIssueUrl: string, botToken: string) {
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

  private async getJiraIssueKeyFromUrl(url: string): Promise<string> {
    const issueInfoUrl = `${url}?fields=key`;
    core.info(`Info url: ${issueInfoUrl}`);
    const {
      data: { key },
    } = await axios.get(issueInfoUrl, {
      headers: { Authorization: `Bearer ${this.botToken}` },
    });

    return key;
  }

  private async watchersUrl() {
    if(this.issueKey == '') {
      const issueKey = await this.getJiraIssueKeyFromUrl(this.jiraIssueUrl);
      this.issueKey = issueKey;
    }

    const bu = core.getInput("jiraBaseUrl");
    return `${bu}/rest/api/2/issue/${this.issueKey}/watchers`;
  }


  private async getJiraIssueWatchers(): Promise<string[]> {
    const watchersUrl = await this.watchersUrl();
    const watcherResponse = await axios.get(watchersUrl, {
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    return watcherResponse.data.watchers.map(m => m.emailAddress);
  }

  private async addRemoteWatcher(watcherEmail: string): Promise<RemoteWatcherResult> {
    const watchersUrl = await this.watchersUrl();
    const reqBody = `"${watcherEmail}"`;

    // Wrap error with email that failed so it can be reported by consumer
    return new Promise((resolve, reject) => {
      axios.post(watchersUrl, reqBody, {
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
          error: err})
      });
    });
  }

  private async deleteRemoteWatcher(watcherEmail: string): Promise<RemoteWatcherResult> {
    var watchersUrl = await this.watchersUrl();
    watchersUrl = `${watchersUrl}?username=${watcherEmail}`;
    core.info(`deleteRemoteWatcher: ${watchersUrl}`);

    // Wrap error with email that failed so it can be reported by consumer
    return new Promise((resolve, reject) => {
      axios.delete(watchersUrl, {
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
          error: err})
      });
      // .then(() => resolve({email: watcherEmail, error: null}))
      // .catch(err => reject({email: watcherEmail, error: err}));
    });
  }

  async ensureDesiredWatchers() {
    if(this.addWatchers.length === 0) {
      core.info('No desired watchers have been configured and none will be added');
      return
    }

    core.debug('Ensuring desired watchers');
    core.debug(JSON.stringify(this.addWatchers));
    core.debug(JSON.stringify(this.removeWatchers));

    const currentWatchers = await this.getJiraIssueWatchers();

    core.debug('Current watcher list:')
    core.debug(JSON.stringify(currentWatchers));

    const watchersToAdd : string [] = this.addWatchers.reduce((toAdd : string[], d) => {
      return currentWatchers.includes(d) ? toAdd : [...toAdd, d];
    }, []);

    const watchersToDelete: string [] = this.removeWatchers.reduce((toDelete: string[], d) => {
      return currentWatchers.includes(d) ? [...toDelete, d] : toDelete;
    }, []);

    core.info('Adding missing watchers:')
    core.info(JSON.stringify(watchersToAdd));

    core.info('Removing watchers that should not be present:')
    core.info(JSON.stringify(watchersToDelete));

    const mutateWatchersFn = (_watcherEmails: string[], mutationFn) => {
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
        const results = await Promise.allSettled(
          _watcherEmails.map(email => mutationFn(email))
        );

        core.info('Got results from core watcher fn');
        core.info(`${JSON.stringify(results)}`);

        // Annoyingly Typescript has no way to understand what's in the results
        // array, so this actually requires a cast
        const failures = (results.filter(res =>res.status === 'rejected'
          ) as PromiseRejectedResult[]);

        if(failures.length != 0) {
          core.warning(`Failed to change ${failures.length} watcher(s), operating on list: ${JSON.stringify(_watcherEmails)}:`);
          failures.forEach(err => core.error(JSON.stringify(err)));
        }
      }
    }

    await mutateWatchersFn(watchersToAdd, this.addRemoteWatcher)();
    await mutateWatchersFn(watchersToDelete, this.deleteRemoteWatcher)();
  }
}

export { JiraWatcherManager };
