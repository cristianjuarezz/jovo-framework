import {
  bundleProject,
  loadProject,
  loadProjectConfig,
  ParseError,
  validateProject,
} from '@alexa/acdl';
import type { DeployPlatformContext, DeployPlatformEvents } from '@jovotech/cli-command-deploy';
import {
  chalk,
  execAsync,
  flags,
  InstallContext,
  JovoCliError,
  Log,
  printStage,
  ROCKET,
  Task,
  wait,
} from '@jovotech/cli-core';
import { axios } from '@jovotech/framework';
import AdmZip from 'adm-zip';
import { existsSync, readdirSync, statSync } from 'fs';
import _get from 'lodash.get';
import { join as joinPaths } from 'path';
import { AlexaCli } from '..';
import { AlexaContext, ImportStatus } from '../interfaces';
import * as smapi from '../smapi';
import { getImportStatus } from '../smapi';
import { checkForAskCli, getACValidationErrorHint } from '../utilities';
import { AlexaHook } from './AlexaHook';

export interface DeployPlatformContextAlexa extends AlexaContext, DeployPlatformContext {
  flags: DeployPlatformContext['flags'] & { 'ask-profile'?: string; 'skill-id'?: string };
  alexa: AlexaContext['alexa'] & {
    skillCreated?: boolean;
    isACSkill?: boolean;
  };
}

export class DeployHook extends AlexaHook<DeployPlatformEvents> {
  $plugin!: AlexaCli;
  $context!: DeployPlatformContextAlexa;

  install(): void {
    this.middlewareCollection = {
      'install': [this.addCliOptions.bind(this)],
      'before.deploy:platform': [
        this.checkForPlatform.bind(this),
        checkForAskCli,
        this.updatePluginContext.bind(this),
        this.checkForPlatformsFolder.bind(this),
        this.updatePluginContext.bind(this),
      ],
      'deploy:platform': [this.deploy.bind(this)],
    };
  }

  /**
   * Add platform-specific CLI options, including flags and args.
   * @param context - Context providing an access point to command flags and args.
   */
  addCliOptions(context: InstallContext): void {
    if (context.command !== 'deploy:platform') {
      return;
    }

    context.flags['ask-profile'] = flags.string({
      description: 'Name of used ASK profile',
    });
    context.flags['skill-id'] = flags.string({ char: 's', description: 'Alexa Skill ID' });
  }

  /**
   * Checks if the currently selected platform matches this CLI plugin.
   */
  checkForPlatform(): void {
    // Check if this plugin should be used or not.
    if (!this.$context.platforms.includes(this.$plugin.id)) {
      this.uninstall();
    }
  }

  /**
   * Updates the current plugin context with platform-specific values.
   */
  async updatePluginContext(): Promise<void> {
    super.updatePluginContext();

    this.$context.alexa.askProfile =
      this.$context.flags['ask-profile'] ||
      this.$plugin.config.askProfile ||
      (await this.getAskProfile());

    this.$context.alexa.skillId = this.$context.flags['skill-id'] || this.getSkillId();
    // TODO: this.$plugin.config.convertsations.enabled enough?
    this.$context.alexa.isACSkill =
      this.$plugin.config.conversations?.enabled && existsSync(this.$plugin.conversationsDirectory);
  }

  /**
   * Checks if the platform folder for the current plugin exists.
   */
  checkForPlatformsFolder(): void {
    if (!existsSync(this.$plugin.platformPath)) {
      throw new JovoCliError({
        message: `Couldn't find the platform folder "${this.$plugin.platformDirectory}/".`,
        module: this.$plugin.name,
        hint: `Please use "jovo build" to create platform-specific files.`,
      });
    }
  }

  /**
   * Deploys platform-specific models to the Alexa Skills Console.
   */
  async deploy(): Promise<void> {
    const deployTask: Task = new Task(
      `${ROCKET} Deploying Alexa Skill ${printStage(this.$cli.project!.stage)}`,
    );

    // Deployment is done by compressing the skill-package and importing it into the developer console.
    // Depending on whether the current skill uses Alexa Conversations or not, the location of the
    // skill package changes.
    const zipPath: string = this.$context.alexa.isACSkill
      ? this.$plugin.skillPackagePath
      : joinPaths(this.$plugin.platformPath, 'build', 'skill-package');

    if (this.$context.alexa.isACSkill) {
      const projectConfig = await loadProjectConfig(
        this.$plugin.platformPath,
        this.$context.alexa.askProfile,
      );
      const project = await loadProject(projectConfig);

      if (!this.$plugin.config.conversations?.skipValidation) {
        const validationTask: Task = new Task('Validating ACDL files', async () => {
          const errors: ParseError[] = validateProject(project, true);

          if (errors.length) {
            throw new JovoCliError({
              message: 'Validation failed for Alexa Conversations',
              module: this.$plugin.name,
              hint: getACValidationErrorHint(errors),
            });
          }

          await wait(500);
        });

        deployTask.add(validationTask);
      }

      const compileTask: Task = new Task('Compiling ACDL files', async () => {
        await bundleProject(project);
        await wait(1000);
      });

      deployTask.add(compileTask);
    }

    const uploadTask: Task = new Task('Uploading skill package', async () => {
      // Compress skill package
      const zip: AdmZip = new AdmZip();

      for (const entry of readdirSync(zipPath)) {
        const path: string = joinPaths(zipPath, entry);
        if (statSync(path).isDirectory()) {
          zip.addLocalFolder(path);
        } else {
          zip.addLocalFile(path);
        }
      }

      const uploadUrl: string = await smapi.createNewUploadUrl();
      await axios({ url: uploadUrl, method: 'PUT', data: zip.toBuffer() });

      const importUrl: string | undefined = this.$context.alexa.skillId
        ? await smapi.importSkillPackage(
            uploadUrl,
            this.$context.alexa.skillId,
            this.$context.alexa.askProfile,
          )
        : await smapi.createSkillPackage(uploadUrl, this.$context.alexa.askProfile);

      if (!importUrl) {
        throw new JovoCliError({
          message: 'Something went wrong while importing your skill package',
          hint: 'Try importing your skill package manually using the ASK CLI and copy the resulting skill ID into your project configuration',
        });
      }

      // Check import
      const status: ImportStatus = await getImportStatus(importUrl);
      const skillId = status.skill.skillId;
      this.$context.alexa.skillId = skillId;
      this.setSkillId(skillId);

      return `Skill ID: ${skillId}`;
    });

    deployTask.add(uploadTask);

    if (this.$context.alexa.skillCreated) {
      const enableTestingTask: Task = new Task('Enabling skill for testing', async () => {
        await smapi.enableSkill(
          this.$context.alexa.skillId!,
          'development',
          this.$context.alexa.askProfile,
        );
      });
      deployTask.add(enableTestingTask);
    }

    await deployTask.run();
  }

  /**
   * Returns Alexa Skill ID from .ask/config.
   */
  getSkillId(): string | undefined {
    try {
      const askConfig = this.getAskConfig();
      const askProfile: string = this.$context.alexa.askProfile || 'default';
      const skillId: string = _get(askConfig, `profiles.${askProfile}.skillId`);
      if (skillId && skillId.length > 0) {
        return skillId;
      }
    } catch (err) {
      if (err instanceof JovoCliError) {
        throw err;
      }
      throw new JovoCliError({ message: err.message, module: this.$plugin.name });
    }
  }

  /**
   * Returns skill information.
   */
  getSkillInformation(): { name: string; skillId?: string } {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const skillJson = require(this.$plugin.skillJsonPath);
      const info = {
        name: '',
        skillId: this.getSkillId(),
      };

      const locales = _get(skillJson, 'manifest.publishingInformation.locales', []);

      for (const locale of Object.keys(locales)) {
        info.name += locales[locale].name + ' (' + locale + ') ';
      }

      return info;
    } catch (err) {
      throw new JovoCliError({ message: err.message, module: this.$plugin.name });
    }
  }

  /**
   * Returns the skill's invocation name.
   * @param locale - The locale for which to get the invocation name.
   */
  getInvocationName(locale: string): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const alexaModel = require(this.$plugin.getModelPath(locale));
    return _get(alexaModel, 'interactionModel.languageModel.invocationName');
  }
}
