#!/usr/bin/env node

import { Command } from 'commander';

const program = new Command();

program
  .name('eclair-tools')
  .description('CLI utils for the ECLAIR Manager panel configurations')
  .version('0.1.0');

interface AnalyzeOptions {
  output?: string;
  format: 'json' | 'text' | 'csv';
  strict: boolean;
  verbose: boolean;
}

program
  .command('analyze')
  .description('Analyze an ECLAIR report at the given path')
  .argument('<path>', 'Path to the ECLAIR report or project directory to analyze')
  .option('-o, --output <file>', 'Write output to a file instead of stdout')
  .option('-f, --format <format>', 'Output format: json, text, or csv', 'text')
  .option('--strict', 'Treat warnings as errors')
  .option('--verbose', 'Enable verbose logging')
  .action((path: string, options: AnalyzeOptions) => {
    console.log(`Analyzing: ${path}`);
    console.log('Options:', options);
    // TODO: implement analysis logic
  });

program.parse(process.argv);
