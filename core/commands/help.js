'use strict'
const reload = require('require-reload')(require);
const ErisUtils = reload('./../util/eris_utils.js');

function validateCommand(command) {
  let commandName = command.aliases[0];
  if (command.shortDescription && typeof command.shortDescription !== typeof '') {
    throw new Error('The shortDescription must be a string. It is not for ' + commandName);
  } else if (command.usageExample && typeof command.usageExample !== typeof '') {
    throw new Error('The usageExample must be a string. It is not for ' + commandName);
  } else if (command.longDescription && typeof command.longDescription !== typeof '') {
    throw new Error('The longDescription must be a string. It is not for ' + commandName);
  } else if (command.aliasesForHelp && (!Array.isArray(command.aliasesForHelp) || command.aliasesForHelp.length < 1)) {
    throw new Error('The aliasesForHelp must be an array. It is not for ' + commandName);
  }
}

function createTopLevelHelpTextForCommands(commands, helpCommandAlias) {
  if (commands.length === 0) {
    return;
  }
  let helpText = '```glsl\n';
  for (let command of commands) {
    helpText += createTopLevelHelpTextForCommand(command) + '\n';
  }
  helpText += `\nSay ${helpCommandAlias} [command name] to see more help for a command. Example: ${helpCommandAlias} ${commands[0].aliases[0]}\n\`\`\``;
  return helpText;
}

function createTopLevelHelpTextForCommand(command) {
  validateCommand(command);
  let aliases = command.aliasesForHelp || command.aliases;
  let firstAlias = aliases[0];
  let otherAliases = aliases.slice(1);
  let helpText = firstAlias;
  if (otherAliases.length > 0) {
    helpText += ` (aliases: ${otherAliases.join(', ')})`;
  }
  if (command.shortDescription || command.usageExample) {
    helpText += '\n    # ';
  }
  if (command.shortDescription) {
    helpText += command.shortDescription + ' ';
  }
  if (command.usageExample) {
    helpText += 'Example: ' + command.usageExample;
  }

  return helpText;
}

function findCommandWithAlias(commands, alias) {
  return commands.find(command => command.aliases.indexOf(alias) !== -1);
}

function findCloseMatchCommandForAlias(commands, alias) {
  let currentCandidate;
  let currentCandidateAlias;
  for (let command of commands) {
    for (let candidateAlias of command.aliases) {
      if (candidateAlias.indexOf(alias) !== -1) {
        if (!currentCandidateAlias || currentCandidateAlias.length > candidateAlias.length) {
          currentCandidateAlias = candidateAlias;
          currentCandidate = command;
        }
      }
    }
  }
  return currentCandidate;
}

function indexOfAliasInList(command, list) {
  for (let alias of command.aliases) {
    let index = list.indexOf(alias);
    if (index !== -1) {
      return index;
    }
  }
  return -1;
}

function compareCommandOrder(commandA, commandB, orderList) {
  return indexOfAliasInList(commandA, orderList) - indexOfAliasInList(commandB, orderList);
}

/**
* A command for reloading the command and message managers. This is a special command that the command manager has direct knowledge of.
*/
class Help {
  /**
  * @param {Array<Command>} otherCommands - The commands that should be considered to be included in the help.
  * @param {Array<String>} enabledSettingsForOtherCommands - An array of the enable setting name for each command.
  *   Must be parallel to the otherCommands array.
  * @param {Object} config - The monochrome config.
  */
  constructor(otherCommands, config) {
    this.commandAliases = config.autoGeneratedHelpCommandAliases;
    this.embedColor_ = config.colorForAutoGeneratedHelpEmbeds;
    this.uniqueId = 'autoGeneratedHelp425654';
    this.commandsToGenerateHelpFor_ = otherCommands
      .filter(command => indexOfAliasInList(command, config.commandsToGenerateHelpFor) !== -1)
      .sort((a, b) => compareCommandOrder(a, b, config.commandsToGenerateHelpFor));
    this.requiredSettings = this.commandsToGenerateHelpFor_
      .map(command => command.getEnabledSettingFullyQualifiedUserFacingName())
      .filter(settingName => !!settingName);
    for (let command of this.commandsToGenerateHelpFor_) {
      validateCommand(command);
    }
    this.action = (bot, msg, suffix, settings) => this.execute_(bot, msg, suffix, settings);
  }

  execute_(bot, msg, suffix, settings) {
    if (suffix) {
      return this.showAdvancedHelp_(msg, suffix, settings);
    } else {
      return this.showGeneralHelp_(msg, settings);
    }
  }

  showAdvancedHelp_(msg, targetAlias, settings) {
    let command = findCommandWithAlias(this.commandsToGenerateHelpFor_, targetAlias);
    if (!command) {
      command = findCloseMatchCommandForAlias(this.commandsToGenerateHelpFor_, targetAlias);
    }
    if (!command) {
      return this.showGeneralHelp_(msg, settings);
    }

    let fields = [];
    if (command.getCooldown() !== undefined) {
      fields.push({name: 'Cooldown', value: command.getCooldown().toString() + ' seconds', inline: true});
    }
    let permissionsString = '';

    if (command.getIsForServerAdminOnly()) {
      permissionsString += 'Server admin\n';
    }
    if (command.getIsForBotAdminOnly()) {
      permissionsString += 'Bot admin\n';
    }
    if (!permissionsString) {
      permissionsString += 'None';
    }
    fields.push({name: 'Required permissions', value: permissionsString, inline: true});
    if (command.usageExample) {
      fields.push({name: 'Usage example', value: command.usageExample});
    }

    let botContent = {
      embed: {
        title: command.aliases[0],
        description: command.longDescription || command.shortDescription,
        color: this.embedColor_,
        fields: fields,
      }
    }

    return msg.channel.createMessage(botContent);
  }

  showGeneralHelp_(msg, settings) {
    let commandsToDisplayHelpFor = [];
    for (let command of this.commandsToGenerateHelpFor_) {
      let enabledSettingName = command.getEnabledSettingFullyQualifiedUserFacingName();
      if (enabledSettingName && !settings[enabledSettingName]) {
        continue;
      }
      commandsToDisplayHelpFor.push(command);
    }

    let helpText = createTopLevelHelpTextForCommands(commandsToDisplayHelpFor, this.commandAliases[0]);
    if (helpText) {
      return msg.channel.createMessage(helpText);
    } else {
      return 'No commands to show help for';
    }
  }
}

module.exports = Help;
