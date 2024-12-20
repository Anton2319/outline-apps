// Copyright 2018 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {Localizer} from '@outline/infrastructure/i18n';
import * as net from '@outline/infrastructure/net';

import {
  parseTunnelConfig,
  TunnelConfigJson,
  DynamicServiceConfig,
  StaticServiceConfig,
  parseAccessKey,
} from './config';
import {StartRequestJson, VpnApi} from './vpn';
import * as errors from '../../model/errors';
import {PlatformError} from '../../model/platform_error';
import {Server, ServerType} from '../../model/server';
import {ResourceFetcher} from '../resource_fetcher';

// PLEASE DON'T use this class outside of this `outline_server_repository` folder!

export class OutlineServer implements Server {
  public readonly type: ServerType;
  readonly tunnelConfigLocation: URL;
  private displayAddress: string;
  private readonly staticTunnelConfig?: TunnelConfigJson;
  errorMessageId?: string;

  constructor(
    private vpnApi: VpnApi,
    readonly urlFetcher: ResourceFetcher,
    readonly id: string,
    public name: string,
    readonly accessKey: string,
    localize: Localizer
  ) {
    const serviceConfig = parseAccessKey(accessKey);
    this.name = name ?? serviceConfig.name;

    if (serviceConfig instanceof DynamicServiceConfig) {
      this.type = ServerType.DYNAMIC_CONNECTION;
      this.tunnelConfigLocation = serviceConfig.transportConfigLocation;
      this.displayAddress = '';

      if (!this.name) {
        this.name =
          this.tunnelConfigLocation.port === '443'
            ? this.tunnelConfigLocation.hostname
            : net.joinHostPort(
                this.tunnelConfigLocation.hostname,
                this.tunnelConfigLocation.port
              );
      }
    } else if (serviceConfig instanceof StaticServiceConfig) {
      this.type = ServerType.STATIC_CONNECTION;
      this.staticTunnelConfig = serviceConfig.tunnelConfig;
      const firstHop = serviceConfig.tunnelConfig.firstHop;
      this.displayAddress = net.joinHostPort(
        firstHop.host,
        firstHop.port.toString()
      );

      if (!this.name) {
        this.name = localize(
          accessKey.includes('outline=1')
            ? 'server-default-name-outline'
            : 'server-default-name'
        );
      }
    }
  }

  get address() {
    return this.displayAddress;
  }

  async connect() {
    let tunnelConfig: TunnelConfigJson;
    if (this.type === ServerType.DYNAMIC_CONNECTION) {
      tunnelConfig = await fetchTunnelConfig(
        this.urlFetcher,
        this.tunnelConfigLocation
      );
      this.displayAddress = net.joinHostPort(
        tunnelConfig.firstHop.host,
        tunnelConfig.firstHop.port.toString()
      );
    } else {
      tunnelConfig = this.staticTunnelConfig;
    }

    try {
      const request: StartRequestJson = {
        id: this.id,
        name: this.name,
        config: tunnelConfig,
      };
      await this.vpnApi.start(request);
    } catch (cause) {
      // TODO(junyi): Remove the catch above once all platforms are migrated to PlatformError
      if (cause instanceof PlatformError) {
        throw cause;
      }

      // e originates in "native" code: either Cordova or Electron's main process.
      // Because of this, we cannot assume "instanceof OutlinePluginError" will work.
      if (cause.errorCode) {
        throw errors.fromErrorCode(cause.errorCode);
      }

      throw new errors.ProxyConnectionFailure(
        `Failed to connect to server ${this.name}.`,
        {cause}
      );
    }
  }

  async disconnect() {
    try {
      await this.vpnApi.stop(this.id);

      if (this.type === ServerType.DYNAMIC_CONNECTION) {
        this.displayAddress = '';
      }
    } catch (e) {
      // All the plugins treat disconnection errors as ErrorCode.UNEXPECTED.
      throw new errors.RegularNativeError();
    }
  }

  checkRunning(): Promise<boolean> {
    return this.vpnApi.isRunning(this.id);
  }
}

/** fetchTunnelConfig fetches information from a dynamic access key and attempts to parse it. */
// TODO(daniellacosse): unit tests
async function fetchTunnelConfig(
  urlFetcher: ResourceFetcher,
  configLocation: URL
): Promise<TunnelConfigJson> {
  const responseBody = (
    await urlFetcher.fetch(configLocation.toString())
  ).trim();
  if (!responseBody) {
    throw new errors.ServerAccessKeyInvalid(
      'Got empty config from dynamic key.'
    );
  }
  try {
    return parseTunnelConfig(responseBody);
  } catch (cause) {
    if (cause instanceof errors.SessionProviderError) {
      throw cause;
    }

    throw new errors.ServerAccessKeyInvalid(
      'Failed to parse VPN information fetched from dynamic access key.',
      {cause}
    );
  }
}
