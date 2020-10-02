/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from "fs-extra";
import path from "path";
import admonitions from "remark-admonitions";
import { normalizeUrl, docuHash } from "@docusaurus/utils";
import {
  LoadContext,
  Plugin,
  RouteConfig,
  ConfigureWebpackUtils,
} from "@docusaurus/types";
import { Configuration, Loader } from "webpack";

import { PluginOptions, LoadedContent, ApiSection } from "./types";
import { loadOpenapi } from "./openapi";

const DEFAULT_OPTIONS: PluginOptions = {
  routeBasePath: "api",
  openapiPath: "",
  apiLayoutComponent: "@theme/ApiPage",
  apiItemComponent: "@theme/ApiItem",
  remarkPlugins: [],
  rehypePlugins: [],
  admonitions: {},
  sidebarLabel: "summary",
  pageId: "summary",
};

export default function pluginOpenAPI(
  context: LoadContext,
  opts: Partial<PluginOptions>
): Plugin<LoadedContent | null> {
  const name = "docusaurus-plugin-openapi";

  const options: PluginOptions = { ...DEFAULT_OPTIONS, ...opts };
  const homePageDocsRoutePath =
    options.routeBasePath === "" ? "/" : options.routeBasePath;

  if (options.admonitions) {
    options.remarkPlugins = options.remarkPlugins.concat([
      [admonitions, options.admonitions],
    ]);
  }

  const { baseUrl, generatedFilesDir } = context;

  const dataDir = path.join(generatedFilesDir, name);

  return {
    name: name,

    getThemePath() {
      return path.resolve(__dirname, "./theme");
    },

    getPathsToWatch() {
      return [options.openapiPath];
    },

    getClientModules() {
      const modules = [];

      if (options.admonitions) {
        modules.push(require.resolve("remark-admonitions/styles/infima.css"));
      }

      return modules;
    },

    async loadContent() {
      const { routeBasePath, openapiPath } = options;

      if (!openapiPath || !fs.existsSync(openapiPath)) {
        return null;
      }

      const openapiData = await loadOpenapi(
        openapiPath,
        baseUrl,
        routeBasePath,
        options
      );

      return { openapiData };
    },

    async contentLoaded({ content, actions }) {
      if (!content || Object.keys(content.openapiData).length === 0) {
        return;
      }

      const openapiData = content.openapiData as ApiSection[];
      const { routeBasePath, apiLayoutComponent, apiItemComponent } = options;
      const { addRoute, createData } = actions;

      const sidebar = openapiData.map((category) => {
        return {
          collapsed: true,
          type: "category",
          label: category.title,
          items: category.items.map((item) => {
            return {
              href: item.permalink,
              label: item[options.sidebarLabel],
              type: "link",
              deprecated: item.deprecated,
            };
          }),
        };
      });

      const promises = openapiData
        .map((section) => {
          return section.items.map(async (item) => {
            const pageId = `site-${routeBasePath}-${item.hashId}`;
            const openapiDataPath = await createData(
              `${docuHash(pageId)}.json`,
              JSON.stringify(item)
            );

            const markdown = await createData(
              `${docuHash(pageId)}-description.md`,
              item.description
            );
            return {
              path: item.permalink,
              component: apiItemComponent,
              exact: true,
              modules: {
                openapi: openapiDataPath,
                content: {
                  __import: true,
                  path: markdown,
                },
              },
            };
          });
        })
        .flat();

      const routes = (await Promise.all(promises)) as RouteConfig[];

      const permalinkToSidebar = routes.reduce(
        (acc: { [key: string]: string }, item) => {
          acc[item.path] = "sidebar";
          return acc;
        },
        {}
      );

      // Important: the layout component should not end with /,
      // as it conflicts with the home doc
      // Workaround fix for https://github.com/facebook/docusaurus/issues/2917
      const apiBaseRoute = normalizeUrl([baseUrl, routeBasePath]);
      const basePath = apiBaseRoute === "/" ? "" : apiBaseRoute;

      const docsBaseMetadataPath = await createData(
        `${docuHash(normalizeUrl([apiBaseRoute, ":route"]))}.json`,
        JSON.stringify(
          {
            docsSidebars: {
              sidebar: sidebar,
            },
            permalinkToSidebar: permalinkToSidebar,
          },
          null,
          2
        )
      );

      addRoute({
        path: basePath,
        exact: false, // allow matching /docs/* as well
        component: apiLayoutComponent, // main docs component (DocPage)
        routes, // subroute for each doc
        modules: {
          docsMetadata: docsBaseMetadataPath,
        },
      });

      return;
    },

    async routesLoaded(routes) {
      const homeDocsRoutes = routes.filter(
        (routeConfig) => routeConfig.path === homePageDocsRoutePath
      );

      // Remove the route for docs home page if there is a page with the same path (i.e. docs).
      if (homeDocsRoutes.length > 1) {
        const docsHomePageRouteIndex = routes.findIndex(
          (route) =>
            route.component === options.apiLayoutComponent &&
            route.path === homePageDocsRoutePath
        );

        delete routes[docsHomePageRouteIndex!];
      }
    },

    configureWebpack(
      _config: Configuration,
      isServer: boolean,
      { getBabelLoader, getCacheLoader }: ConfigureWebpackUtils
    ) {
      const { rehypePlugins, remarkPlugins } = options;

      return {
        resolve: {
          alias: {
            "~api": dataDir,
          },
        },
        module: {
          rules: [
            {
              test: /(\.mdx?)$/,
              include: [dataDir],
              use: [
                getCacheLoader(isServer),
                getBabelLoader(isServer),
                {
                  loader: require.resolve("@docusaurus/mdx-loader"),
                  options: {
                    remarkPlugins,
                    rehypePlugins,
                  },
                },
              ] as Loader[],
            },
          ],
        },
      };
    },
  };
}
