/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { parseEntityRef } from '@backstage/catalog-model';
import {
  DiscoveryApi,
  FetchApi,
  IdentityApi,
} from '@backstage/core-plugin-api';
import { ResponseError } from '@backstage/errors';
import { ScmIntegrationRegistry } from '@backstage/integration';
import {
  ListActionsResponse,
  ListTemplatingExtensionsResponse,
  LogEvent,
  ScaffolderApi,
  ScaffolderDryRunOptions,
  ScaffolderDryRunResponse,
  ScaffolderGetIntegrationsListOptions,
  ScaffolderGetIntegrationsListResponse,
  ScaffolderScaffoldOptions,
  ScaffolderScaffoldResponse,
  ScaffolderStreamLogsOptions,
  ScaffolderTask,
  TemplateParameterSchema,
} from '@backstage/plugin-scaffolder-react';
import { Observable } from '@backstage/types';
import {
  EventSourceMessage,
  fetchEventSource,
} from '@microsoft/fetch-event-source';
import { default as qs, default as queryString } from 'qs';
import ObservableImpl from 'zen-observable';

/**
 * An API to interact with the scaffolder backend.
 *
 * @public
 */
export class ScaffolderClient implements ScaffolderApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly scmIntegrationsApi: ScmIntegrationRegistry;
  private readonly fetchApi: FetchApi;
  private readonly identityApi?: IdentityApi;
  private readonly useLongPollingLogs: boolean;

  constructor(options: {
    discoveryApi: DiscoveryApi;
    fetchApi: FetchApi;
    identityApi?: IdentityApi;
    scmIntegrationsApi: ScmIntegrationRegistry;
    useLongPollingLogs?: boolean;
  }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi ?? { fetch };
    this.scmIntegrationsApi = options.scmIntegrationsApi;
    this.useLongPollingLogs = options.useLongPollingLogs ?? false;
    this.identityApi = options.identityApi;
  }

  async listTasks(options: {
    filterByOwnership: 'owned' | 'all';
    limit?: number;
    offset?: number;
  }): Promise<{ tasks: ScaffolderTask[]; totalTasks?: number }> {
    if (!this.identityApi) {
      throw new Error(
        'IdentityApi is not available in the ScaffolderClient, please pass through the IdentityApi to the ScaffolderClient constructor in order to use the listTasks method',
      );
    }
    const baseUrl = await this.discoveryApi.getBaseUrl('scaffolder');
    const { userEntityRef } = await this.identityApi.getBackstageIdentity();

    const query = queryString.stringify({
      createdBy:
        options.filterByOwnership === 'owned' ? userEntityRef : undefined,
      limit: options.limit,
      offset: options.offset,
    });

    const response = await this.fetchApi.fetch(`${baseUrl}/v2/tasks?${query}`);
    if (!response.ok) {
      throw await ResponseError.fromResponse(response);
    }

    return await response.json();
  }

  async getIntegrationsList(
    options: ScaffolderGetIntegrationsListOptions,
  ): Promise<ScaffolderGetIntegrationsListResponse> {
    const integrations = [
      ...this.scmIntegrationsApi.azure.list(),
      ...this.scmIntegrationsApi.bitbucket
        .list()
        .filter(
          item =>
            !this.scmIntegrationsApi.bitbucketCloud.byHost(item.config.host) &&
            !this.scmIntegrationsApi.bitbucketServer.byHost(item.config.host),
        ),
      ...this.scmIntegrationsApi.bitbucketCloud.list(),
      ...this.scmIntegrationsApi.bitbucketServer.list(),
      ...this.scmIntegrationsApi.gerrit.list(),
      ...this.scmIntegrationsApi.gitea.list(),
      ...this.scmIntegrationsApi.github.list(),
      ...this.scmIntegrationsApi.gitlab.list(),
    ]
      .map(c => ({ type: c.type, title: c.title, host: c.config.host }))
      .filter(c => options.allowedHosts.includes(c.host));

    return {
      integrations,
    };
  }

  async getTemplateParameterSchema(
    templateRef: string,
  ): Promise<TemplateParameterSchema> {
    const { namespace, kind, name } = parseEntityRef(templateRef, {
      defaultKind: 'template',
    });

    const baseUrl = await this.discoveryApi.getBaseUrl('scaffolder');
    const templatePath = [namespace, kind, name]
      .map(s => encodeURIComponent(s))
      .join('/');

    const url = `${baseUrl}/v2/templates/${templatePath}/parameter-schema`;

    const response = await this.fetchApi.fetch(url);
    if (!response.ok) {
      throw await ResponseError.fromResponse(response);
    }

    const schema: TemplateParameterSchema = await response.json();
    return schema;
  }

  async scaffold(
    options: ScaffolderScaffoldOptions,
  ): Promise<ScaffolderScaffoldResponse> {
    const { templateRef, values, secrets = {} } = options;
    const url = `${await this.discoveryApi.getBaseUrl('scaffolder')}/v2/tasks`;
    const response = await this.fetchApi.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        templateRef,
        values: { ...values },
        secrets,
      }),
    });

    if (response.status !== 201) {
      const status = `${response.status} ${response.statusText}`;
      const body = await response.text();
      throw new Error(`Backend request failed, ${status} ${body.trim()}`);
    }

    const { id } = (await response.json()) as { id: string };
    return { taskId: id };
  }

  async getTask(taskId: string): Promise<ScaffolderTask> {
    const baseUrl = await this.discoveryApi.getBaseUrl('scaffolder');
    const url = `${baseUrl}/v2/tasks/${encodeURIComponent(taskId)}`;

    const response = await this.fetchApi.fetch(url);
    if (!response.ok) {
      throw await ResponseError.fromResponse(response);
    }

    return await response.json();
  }

  streamLogs(options: ScaffolderStreamLogsOptions): Observable<LogEvent> {
    if (this.useLongPollingLogs) {
      return this.streamLogsPolling(options);
    }

    return this.streamLogsEventStream(options);
  }

  async dryRun(
    options: ScaffolderDryRunOptions,
  ): Promise<ScaffolderDryRunResponse> {
    const baseUrl = await this.discoveryApi.getBaseUrl('scaffolder');
    const response = await this.fetchApi.fetch(`${baseUrl}/v2/dry-run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        template: options.template,
        values: options.values,
        secrets: options.secrets,
        directoryContents: options.directoryContents,
      }),
    });

    if (!response.ok) {
      throw await ResponseError.fromResponse(response);
    }

    return response.json();
  }

  private streamLogsEventStream({
    isTaskRecoverable,
    taskId,
    after,
  }: ScaffolderStreamLogsOptions): Observable<LogEvent> {
    return new ObservableImpl(subscriber => {
      const params = new URLSearchParams();
      if (after !== undefined) {
        params.set('after', String(Number(after)));
      }

      this.discoveryApi.getBaseUrl('scaffolder').then(
        baseUrl => {
          const url = `${baseUrl}/v2/tasks/${encodeURIComponent(
            taskId,
          )}/eventstream`;

          const processEvent = (event: any) => {
            if (event.data) {
              try {
                subscriber.next(JSON.parse(event.data));
              } catch (ex) {
                subscriber.error(ex);
              }
            }
          };

          const ctrl = new AbortController();
          void fetchEventSource(url, {
            fetch: this.fetchApi.fetch,
            signal: ctrl.signal,
            onmessage(e: EventSourceMessage) {
              if (e.event === 'log') {
                processEvent(e);
                return;
              } else if (e.event === 'completion' && !isTaskRecoverable) {
                processEvent(e);
                subscriber.complete();
                ctrl.abort();
                return;
              }
              processEvent(e);
            },
            onerror(err) {
              subscriber.error(err);
            },
          });
        },
        error => {
          subscriber.error(error);
        },
      );
    });
  }

  private streamLogsPolling({
    taskId,
    after: inputAfter,
  }: {
    taskId: string;
    after?: number;
  }): Observable<LogEvent> {
    let after = inputAfter;

    return new ObservableImpl(subscriber => {
      this.discoveryApi.getBaseUrl('scaffolder').then(async baseUrl => {
        while (!subscriber.closed) {
          const url = `${baseUrl}/v2/tasks/${encodeURIComponent(
            taskId,
          )}/events?${qs.stringify({ after })}`;
          const response = await this.fetchApi.fetch(url);

          if (!response.ok) {
            // wait for one second to not run into an
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          }

          const logs = (await response.json()) as LogEvent[];

          for (const event of logs) {
            after = Number(event.id);

            subscriber.next(event);

            if (event.type === 'completion') {
              subscriber.complete();
              return;
            }
          }
        }
      });
    });
  }

  async listActions(): Promise<ListActionsResponse> {
    const baseUrl = await this.discoveryApi.getBaseUrl('scaffolder');
    const response = await this.fetchApi.fetch(`${baseUrl}/v2/actions`);
    if (!response.ok) {
      throw await ResponseError.fromResponse(response);
    }

    return await response.json();
  }

  async listTemplatingExtensions(): Promise<ListTemplatingExtensionsResponse> {
    const baseUrl = await this.discoveryApi.getBaseUrl('scaffolder');
    const response = await this.fetchApi.fetch(
      `${baseUrl}/v2/template-extensions`,
    );
    if (!response.ok) {
      throw ResponseError.fromResponse(response);
    }
    return response.json();
  }

  async cancelTask(taskId: string): Promise<void> {
    const baseUrl = await this.discoveryApi.getBaseUrl('scaffolder');
    const url = `${baseUrl}/v2/tasks/${encodeURIComponent(taskId)}/cancel`;

    const response = await this.fetchApi.fetch(url, {
      method: 'POST',
    });

    if (!response.ok) {
      throw await ResponseError.fromResponse(response);
    }

    return await response.json();
  }

  async retry?(taskId: string): Promise<void> {
    const baseUrl = await this.discoveryApi.getBaseUrl('scaffolder');
    const url = `${baseUrl}/v2/tasks/${encodeURIComponent(taskId)}/retry`;

    const response = await this.fetchApi.fetch(url, {
      method: 'POST',
    });

    if (!response.ok) {
      throw await ResponseError.fromResponse(response);
    }

    return await response.json();
  }

  async autocomplete({
    token,
    resource,
    provider,
    context,
  }: {
    token: string;
    provider: string;
    resource: string;
    context?: Record<string, string>;
  }): Promise<{ results: { title?: string; id: string }[] }> {
    const baseUrl = await this.discoveryApi.getBaseUrl('scaffolder');

    const url = `${baseUrl}/v2/autocomplete/${provider}/${resource}`;

    const response = await this.fetchApi.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        token,
        context: context ?? {},
      }),
    });

    if (!response.ok) {
      throw await ResponseError.fromResponse(response);
    }

    const { results } = await response.json();
    return { results };
  }
}
