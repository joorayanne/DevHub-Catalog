
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

// --------------------------------------------------
// 1. PROJECT PATHS AND CONSTANTS
// --------------------------------------------------

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(currentFile), '..');

const registryPath = path.join(
  projectRoot,
  'registry',
  'projects.yaml',
);

const catalogDirectory = path.join(projectRoot, 'catalog');
const openApiDirectory = path.join(projectRoot, 'openapi');

const manifestPath = path.join(
  projectRoot,
  '.generated-files.json',
);

const GENERATED_ANNOTATION = 'devhub.io/generated-by';
const GENERATED_VALUE = 'devhub-catalog-sync';

const API_VERSION = 'backstage.io/v1alpha1';

// --------------------------------------------------
// 2. READ THE REGISTRY
// --------------------------------------------------

async function readRegistry() {
  console.log('Reading project registry...');

  const content = await fs.readFile(registryPath, 'utf8');
  const registry = YAML.parse(content);

  if (!registry || !Array.isArray(registry.projects)) {
    throw new Error(
      'Invalid registry: expected a projects array.',
    );
  }

  return registry;
}

// --------------------------------------------------
// 3. VALIDATE THE REGISTRY
// --------------------------------------------------

function validateName(name, description) {
  if (
    typeof name !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
  ) {
    throw new Error(
      `${description} must use lowercase letters, numbers, and hyphens: ${name}`,
    );
  }
}

function validateRegistry(registry) {
  const projectNames = new Set();
  const componentNames = new Set();
  const apiNames = new Set();

  for (const project of registry.projects) {
    validateName(project.name, 'Project name');

    if (!project.title || !project.description) {
      throw new Error(
        `Project ${project.name} needs a title and description.`,
      );
    }

    if (projectNames.has(project.name)) {
      throw new Error(
        `Duplicate project name: ${project.name}`,
      );
    }

    projectNames.add(project.name);

    if (!project.domain) {
      throw new Error(
        `Project ${project.name} must have a domain.`,
      );
    }

    validateName(project.domain, 'Domain name');

    if (!Array.isArray(project.components)) {
      throw new Error(
        `Project ${project.name} must have a components array.`,
      );
    }

    for (const component of project.components) {
      validateName(component.name, 'Component name');

      if (!component.title || !component.description) {
        throw new Error(
          `Component ${component.name} needs a title and description.`,
        );
      }

      if (!component.type) {
        throw new Error(
          `Component ${component.name} needs a type.`,
        );
      }

      if (componentNames.has(component.name)) {
        throw new Error(
          `Duplicate component name: ${component.name}`,
        );
      }

      componentNames.add(component.name);

      if (!Array.isArray(component.apis)) {
        throw new Error(
          `Component ${component.name} must have an apis array.`,
        );
      }

      if (
        component.repositoryUrl &&
        !isHttpUrl(component.repositoryUrl)
      ) {
        throw new Error(
          `Invalid repository URL for ${component.name}.`,
        );
      }

      for (const api of component.apis) {
        validateName(api.name, 'API name');

        if (apiNames.has(api.name)) {
          throw new Error(
            `Duplicate API name: ${api.name}`,
          );
        }

        apiNames.add(api.name);

        if (!api.title || !api.description || !api.openApiUrl) {
          throw new Error(
            `API ${api.name} needs a title, description, and openApiUrl.`,
          );
        }

        if (!isHttpUrl(api.openApiUrl)) {
          throw new Error(
            `Invalid OpenAPI URL for ${api.name}.`,
          );
        }

        if (
          api.swaggerUrls !== undefined &&
          !Array.isArray(api.swaggerUrls)
        ) {
          throw new Error(
            `swaggerUrls for ${api.name} must be an array.`,
          );
        }

        for (const swaggerUrl of api.swaggerUrls ?? []) {
          if (!isHttpUrl(swaggerUrl)) {
            throw new Error(
              `Invalid Swagger URL for ${api.name}: ${swaggerUrl}`,
            );
          }
        }
      }
    }
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === 'http:' ||
      url.protocol === 'https:'
    );
  } catch {
    return false;
  }
}

// --------------------------------------------------
// 4. FETCH AND VALIDATE OPENAPI DOCUMENTS
// --------------------------------------------------

function validateOpenApiDocument(document, apiName) {
  if (
    !document ||
    typeof document !== 'object' ||
    Array.isArray(document)
  ) {
    throw new Error(
      `${apiName}: OpenAPI response must be a JSON object.`,
    );
  }

  const isOpenApi3 =
    typeof document.openapi === 'string' &&
    /^3\.\d+\.\d+$/.test(document.openapi);

  const isSwagger2 =
    document.swagger === '2.0';

  if (!isOpenApi3 && !isSwagger2) {
    throw new Error(
      `${apiName}: response is not a recognized OpenAPI 2 or 3 document.`,
    );
  }

  if (
    !document.info ||
    typeof document.info.title !== 'string' ||
    typeof document.info.version !== 'string'
  ) {
    throw new Error(
      `${apiName}: OpenAPI document must contain info.title and info.version.`,
    );
  }

  if (
    !document.paths ||
    typeof document.paths !== 'object' ||
    Array.isArray(document.paths)
  ) {
    throw new Error(
      `${apiName}: OpenAPI document must contain a paths object.`,
    );
  }
}

async function fetchOpenApi(api) {
  console.log(`  Fetching ${api.name}...`);

  const response = await fetch(api.openApiUrl, {
    signal: AbortSignal.timeout(15000),
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(
      `${api.name}: HTTP ${response.status} ${response.statusText}`,
    );
  }

  let document;

  try {
    document = await response.json();
  } catch {
    throw new Error(
      `${api.name}: server did not return valid JSON.`,
    );
  }

  validateOpenApiDocument(document, api.name);

  return document;
}

// --------------------------------------------------
// 5. GENERATE BACKSTAGE ENTITY HELPERS
// --------------------------------------------------

function generatedMetadata(name, title, description, links = []) {
  return {
    name,
    title,
    description,
    annotations: {
      [GENERATED_ANNOTATION]: GENERATED_VALUE,
    },
    ...(links.length > 0 ? { links } : {}),
  };
}

function createDomainEntity(domainName) {
  const title = domainName
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  return {
    apiVersion: API_VERSION,
    kind: 'Domain',
    metadata: generatedMetadata(
      domainName,
      title,
      `Domain for ${title}`,
    ),
    spec: {},
  };
}

function createSystemEntity(project) {
  return {
    apiVersion: API_VERSION,
    kind: 'System',
    metadata: generatedMetadata(
      project.name,
      project.title,
      project.description,
    ),
    spec: {
      domain: project.domain,
      ...(project.lifecycle
        ? { lifecycle: project.lifecycle }
        : {}),
    },
  };
}

function createComponentEntity(project, component) {
  return {
    apiVersion: API_VERSION,
    kind: 'Component',
    metadata: generatedMetadata(
      component.name,
      component.title,
      component.description,
      component.repositoryUrl
        ? [
            {
              title: 'Source Repository',
              url: component.repositoryUrl,
            },
          ]
        : [],
    ),
    spec: {
      type: component.type,
      system: project.name,
      ...(component.lifecycle
        ? { lifecycle: component.lifecycle }
        : {}),
      ...(component.apis.length > 0
        ? {
            providesApis: component.apis.map(api => api.name),
          }
        : {}),
    },
  };
}

function createApiEntity(api) {
  const swaggerLinks = (api.swaggerUrls ?? []).map(url => ({
    title: 'Swagger UI',
    url,
  }));

  return {
    apiVersion: API_VERSION,
    kind: 'API',
    metadata: generatedMetadata(
      api.name,
      api.title,
      api.description,
      swaggerLinks,
    ),
    spec: {
      type: 'openapi',
      definition: {
        $openapi: `../../openapi/${api.name}.json`,
      },
    },
  };
}

// --------------------------------------------------
// 6. GENERATE ALL ENTITIES AND OPENAPI DOCUMENTS
// --------------------------------------------------

async function generateCatalog(registry) {
  const entities = [];
  const openApiDocuments = new Map();
  const domainNames = new Set();

  console.log('\nFetching OpenAPI specifications...');

  // Fetch all specifications before changing generated files.
  // If one fails, the previous generated catalog remains intact.

  for (const project of registry.projects) {
    domainNames.add(project.domain);

    for (const component of project.components) {
      for (const api of component.apis) {
        const document = await fetchOpenApi(api);

        openApiDocuments.set(api.name, document);
      }
    }
  }

  console.log('\nGenerating Backstage entities...');

  // Generate one Domain entity for each unique domain.

  for (const domainName of domainNames) {
    entities.push({
      directory: 'domains',
      filename: `${domainName}.yaml`,
      entity: createDomainEntity(domainName),
    });
  }

  for (const project of registry.projects) {
    entities.push({
      directory: 'systems',
      filename: `${project.name}.yaml`,
      entity: createSystemEntity(project),
    });

    for (const component of project.components) {
      entities.push({
        directory: 'components',
        filename: `${component.name}.yaml`,
        entity: createComponentEntity(project, component),
      });

      for (const api of component.apis) {
        entities.push({
          directory: 'apis',
          filename: `${api.name}.yaml`,
          entity: createApiEntity(api),
        });
      }
    }
  }

  return {
    entities,
    openApiDocuments,
  };
}

// --------------------------------------------------
// 7. SAVE GENERATED FILES
// --------------------------------------------------

async function writeYamlFile(filePath, data) {
  const content = YAML.stringify(data);

  await fs.writeFile(filePath, content, 'utf8');
}

async function writeJsonFile(filePath, data) {
  const content = JSON.stringify(data, null, 2);

  await fs.writeFile(filePath, content, 'utf8');
}

async function readPreviousManifest() {
  try {
    const content = await fs.readFile(manifestPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        files: [],
      };
    }

    throw error;
  }
}

async function removePreviousGeneratedFiles(previousManifest, currentFiles) {
  const currentSet = new Set(currentFiles);

  for (const relativePath of previousManifest.files ?? []) {
    if (currentSet.has(relativePath)) {
      continue;
    }

    const absolutePath = path.resolve(projectRoot, relativePath);
    const relativeCheck = path.relative(projectRoot, absolutePath);

    // Only allow cleanup inside the generated catalog/openapi folders.
    if (
      relativeCheck.startsWith('..') ||
      path.isAbsolute(relativeCheck) ||
      !(
        relativeCheck.startsWith(`catalog${path.sep}`) ||
        relativeCheck.startsWith(`openapi${path.sep}`)
      )
    ) {
      throw new Error(
        `Unsafe path in generated manifest: ${relativePath}`,
      );
    }

    await fs.rm(absolutePath, {
      force: true,
    });

    console.log(`Removed stale generated file: ${relativePath}`);
  }
}

async function saveGeneratedFiles(entities, openApiDocuments) {
  console.log('\nSaving generated files...');

  const previousManifest = await readPreviousManifest();
  const currentFiles = [];

  await fs.mkdir(openApiDirectory, {
    recursive: true,
  });

  // Write OpenAPI JSON files.

  for (const [apiName, document] of openApiDocuments) {
    const relativePath = path.join('openapi', `${apiName}.json`);
    const absolutePath = path.join(projectRoot, relativePath);

    await writeJsonFile(absolutePath, document);

    currentFiles.push(relativePath);

    console.log(`Saved ${relativePath}`);
  }

  // Write Backstage entity descriptors.

  for (const item of entities) {
    const directoryPath = path.join(
      catalogDirectory,
      item.directory,
    );

    await fs.mkdir(directoryPath, {
      recursive: true,
    });

    const relativePath = path.join(
      'catalog',
      item.directory,
      item.filename,
    );

    const absolutePath = path.join(projectRoot, relativePath);

    await writeYamlFile(absolutePath, item.entity);

    currentFiles.push(relativePath);

    console.log(`Generated ${relativePath}`);
  }

  // Generate the central Location entity.

  const locationEntity = {
    apiVersion: API_VERSION,
    kind: 'Location',
    metadata: {
      name: 'devhub-central-catalog',
      annotations: {
        [GENERATED_ANNOTATION]: GENERATED_VALUE,
      },
    },
    spec: {
      type: 'url',
      targets: entities.map(item => {
        return `./${item.directory}/${item.filename}`;
      }),
    },
  };

  const locationPath = path.join(
    catalogDirectory,
    'location.yaml',
  );

  await writeYamlFile(locationPath, locationEntity);

  console.log('Generated catalog/location.yaml');

  // Record every generated file so stale files can be cleaned safely.

  await removePreviousGeneratedFiles(
    previousManifest,
    currentFiles,
  );

  await writeJsonFile(manifestPath, {
    files: currentFiles,
  });
}

// --------------------------------------------------
// 8. MAIN FUNCTION
// --------------------------------------------------

async function main() {
  console.log('====================================');
  console.log('  DevHub Catalog Synchronization');
  console.log('====================================\n');

  const registry = await readRegistry();

  validateRegistry(registry);

  console.log(
    `Validated ${registry.projects.length} project(s).`,
  );

  const { entities, openApiDocuments } =
    await generateCatalog(registry);

  await saveGeneratedFiles(
    entities,
    openApiDocuments,
  );

  console.log('\n====================================');
  console.log('  Synchronization completed!');
  console.log('====================================');

  console.log(`Projects: ${registry.projects.length}`);
  console.log(
    `Components: ${
      registry.projects.reduce(
        (total, project) => total + project.components.length,
        0,
      )
    }`,
  );
  console.log(`APIs: ${openApiDocuments.size}`);
  console.log(`Generated entities: ${entities.length}`);
}

main().catch(error => {
  console.error('\nSynchronization failed:');
  console.error(error.message);

  process.exitCode = 1;
});
