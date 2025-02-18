import type { NewContext, NewEvents } from '@jovotech/cli-command-new';
import { Log, promptSupportedLocales } from '@jovotech/cli-core';
import { JovoModelData } from '@jovotech/model';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join as joinPaths } from 'path';
import { AlexaCli } from '..';
import AlexaModel from '../boilerplate/AlexaModel.json';
import { SupportedLocales } from '../constants';
import { AlexaContext, SupportedLocalesType } from '../interfaces';
import { AlexaHook } from './AlexaHook';

export class NewHook extends AlexaHook<NewEvents> {
  $plugin!: AlexaCli;
  $context!: NewContext & AlexaContext;

  install(): void {
    this.middlewareCollection = {
      new: [this.setDefaultConfig.bind(this), this.addSystemIntents.bind(this)],
    };
  }

  async setDefaultConfig(): Promise<void> {
    // Check for invalid locales and provide a default locale map.
    for (const locale of this.$context.locales) {
      if (!SupportedLocales.includes(locale as SupportedLocalesType)) {
        // Prompt user for alternative locale.
        Log.spacer();
        const { locales } = await promptSupportedLocales(
          locale,
          'Alexa',
          SupportedLocales as unknown as string[],
        );

        if (!locales.length) {
          continue;
        }

        if (!this.$plugin.config.locales) {
          this.$plugin.config.locales = {};
        }

        this.$plugin.config.locales[locale] = locales as SupportedLocalesType[];
      }
    }
  }

  addSystemIntents(): void {
    const modelsPath: string = joinPaths(
      this.$cli.projectPath,
      this.$context.projectName,
      'models',
    );
    const modelFiles: string[] = readdirSync(modelsPath);

    for (const modelFile of modelFiles) {
      const modelPath: string = joinPaths(modelsPath, modelFile);
      const rawModelData: string = readFileSync(modelPath, 'utf-8');
      const model: JovoModelData = JSON.parse(rawModelData);
      const updatedModel: JovoModelData = { ...model, ...AlexaModel };

      writeFileSync(modelPath, JSON.stringify(updatedModel, null, 2));
    }
  }
}
