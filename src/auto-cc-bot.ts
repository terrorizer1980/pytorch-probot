import {parseSubscriptions} from './subscriptions';
import * as probot from 'probot';

function myBot(app: probot.Application): void {
  const repoConfigs = {};
  const repoSubscriptions = {};

  function repoKey(context: probot.Context): string {
    const repo = context.repo();
    return `${repo.owner}/${repo.repo}`;
  }

  async function loadConfig(
    context: probot.Context,
    force = false
  ): Promise<object> {
    const key = repoKey(context);
    if (!(key in repoConfigs) || force) {
      context.log({key}, 'loadConfig');
      repoConfigs[key] = await context.config('pytorch-probot.yml');
    }
    return repoConfigs[key];
  }

  async function loadSubscriptions(
    context: probot.Context,
    force = false
  ): Promise<object> {
    const key = repoKey(context);
    if (!(key in repoSubscriptions) || force) {
      context.log({key}, 'loadSubscriptions');
      const config = await loadConfig(context);
      const subsPayload = await context.github.issues.get(
        context.repo({number: config['tracking_issue']})
      );
      const subsText = subsPayload.data['body'];
      app.log({subsText});
      repoSubscriptions[key] = parseSubscriptions(subsText);
      app.log({subscriptions: repoSubscriptions[key]});
    }
    return repoSubscriptions[key];
  }

  app.on('issues.edited', async context => {
    const config = await loadConfig(context);
    const issue = context.issue();
    if (config['tracking_issue'] === issue.number) {
      await loadSubscriptions(context, /* force */ true);
    }
  });

  app.on('push', async context => {
    if (context.payload.ref === 'refs/heads/master') {
      await loadConfig(context, /* force */ true);
    }
  });

  app.on('issues.labeled', async context => {
    const subscriptions = await loadSubscriptions(context);

    const labels = context.payload['issue']['labels'].map(e => e['name']);
    context.log({labels});
    const cc = new Set();
    // eslint-disable-next-line github/array-foreach
    labels.forEach(l => {
      if (l in subscriptions) {
        // eslint-disable-next-line github/array-foreach
        subscriptions[l].forEach(u => cc.add(u));
      }
    });
    context.log({cc: Array.from(cc)}, 'from subscriptions');
    if (cc.size) {
      const body = context.payload['issue']['body'];
      const reCC = /cc( +@[a-zA-Z0-9-/]+)+/;
      const oldCCMatch = body.match(reCC);
      const prevCC = new Set();
      if (oldCCMatch) {
        const oldCCString = oldCCMatch[0];
        context.log({oldCCString}, 'previous cc string');
        let m;
        const reUsername = /@([a-zA-Z0-9-/]+)/g;
        while ((m = reUsername.exec(oldCCString)) !== null) {
          prevCC.add(m[1]);
          cc.add(m[1]);
        }
        context.log({prevCC: Array.from(prevCC)}, 'pre-existing ccs');
      }
      // Invariant: prevCC is a subset of cc
      if (prevCC.size !== cc.size) {
        let newCCString = 'cc';
        // eslint-disable-next-line github/array-foreach
        cc.forEach(u => {
          newCCString += ` @${u}`;
        });
        const newBody = oldCCMatch
          ? body.replace(reCC, newCCString)
          : `${body}\n\n${newCCString}`;
        context.log({newBody});
        await context.github.issues.update(context.issue({body: newBody}));
      } else {
        context.log('no action: no change from existing cc list on issue');
      }
    } else {
      context.log('no action: cc list from subscription is empty');
    }
  });
}

export default myBot;
