import md5 from 'md5';
import { ConsoleUtil } from '../util/console-util';
import { OrgFormationError } from '../org-formation-error';
import { CfnTaskProvider, ICfnTask } from './cfn-task-provider';
import { CfnTemplate } from './cfn-template';
import { IResourceTarget } from '~parser/model';
import { TemplateRoot } from '~parser/parser';
import { ICfnTarget, PersistedState } from '~state/persisted-state';
import { ICfnCopyValue, ICfnExpression } from '~core/cfn-expression';

export class CloudFormationBinder {
    private readonly masterAccount: string;
    private readonly invocationHash: string;

    constructor(private readonly stackName: string,
                private readonly template: TemplateRoot,
                private readonly state: PersistedState,
                private readonly parameters: Record<string, string | ICfnCopyValue> = {},
                private readonly forceDeploy: boolean = false,
                private readonly logVerbose: boolean = false,
                private readonly taskRoleName: string = undefined,
                private readonly terminationProtection = false,
                private readonly stackPolicy: {} = undefined,
                private readonly customRoleName?: string,
                private readonly taskProvider: CfnTaskProvider = new CfnTaskProvider(template, state, logVerbose)) {

        this.masterAccount = template.organizationSection.masterAccount.accountId;

        if (this.state.masterAccount && this.masterAccount && this.state.masterAccount !== this.masterAccount) {
            throw new OrgFormationError('state and template do not belong to the same organization');
        }

        const invocation: any = {
            stackName,
            templateHash: template.hash,
            parameters,
            terminationProtection,
        };

        if (this.stackPolicy) {
            invocation.stackPolicy = this.stackPolicy;
        }

        if (this.customRoleName) {
            invocation.cloudFormationRoleName = this.customRoleName;
        }

        if (this.taskRoleName) {
            invocation.taskRoleName = this.taskRoleName;
        }

        this.invocationHash = md5(JSON.stringify(invocation));
    }

    public enumBindings(): ICfnBinding[] {
        const result: ICfnBinding[] = [];
        const targetsInTemplate = [];
        const targets = this.template.resourcesSection.enumTemplateTargets();
        if (this.template.resourcesSection.resources.length > 0 && targets.length === 0) {
            ConsoleUtil.LogWarning('Template does not contain any resource with binding. Remember: bindings need both Account(s) and Region(s)');
        }

        for (const target of targets) {
            const accountBinding = this.state.getAccountBinding(target.accountLogicalId);
            if (!accountBinding) {
                throw new OrgFormationError(`Expected to find an account binding for account ${target.accountLogicalId} in state. Is your organization up to date?`);
            }
            const accountId  = accountBinding.physicalId;
            const region = target.region;
            const stackName = this.stackName;
            const key = {accountId, region, stackName};
            targetsInTemplate.push(key);

            const stored = this.state.getTarget(stackName, accountId, region);
            const cfnTemplate = new CfnTemplate(target, this.template, this.state);

            const binding: ICfnBinding = {
                ...key,
                accountLogicalId: target.accountLogicalId,
                action: 'None',
                target,
                parameters: this.parameters,
                templateHash: this.invocationHash,
                terminationProtection: this.terminationProtection,
                stackPolicy: this.stackPolicy,
                customRoleName: this.taskRoleName,
                cloudFormationRoleName: this.customRoleName,
                state: stored,
                template: cfnTemplate,
                dependencies: [],
                dependents: [],
                regionDependencies: [],
                accountDependencies: [],
            };

            /* move elsewhere */
            const dependsOnAccounts = new Set<string>();
            const dependsOnRegions = new Set<string>();
            for (const resource of target.resources) {
                for (const accountLogicalId of resource.dependsOnAccount) {
                    dependsOnAccounts.add(accountLogicalId);
                }
            }
            for (const resource of target.resources) {
                for (const dependsOnRegion of resource.dependsOnRegion) {
                    dependsOnRegions.add(dependsOnRegion);
                }
            }

            binding.regionDependencies = [...dependsOnRegions];

            for (const dependsOnLogicalAccount of dependsOnAccounts) {
                const dependsOnAccountBinding = this.state.getAccountBinding(dependsOnLogicalAccount);
                if (!dependsOnAccountBinding) {
                    throw new OrgFormationError(`unable to find account with logical Id ${dependsOnLogicalAccount}`);
                }
                binding.accountDependencies.push(dependsOnAccountBinding.physicalId);
            }
            /* end move elsewhere */

            if (this.forceDeploy === true) {
                binding.action = 'UpdateOrCreate';
                ConsoleUtil.LogDebug(`Setting build action on stack ${stackName} for ${accountId}/${region} to ${binding.action} - update was forced.`, this.logVerbose);
            } else if (!stored) {
                binding.action = 'UpdateOrCreate';
                ConsoleUtil.LogDebug(`Setting build action on stack ${stackName} for ${accountId}/${region} to ${binding.action} - no existing target was found in state.`, this.logVerbose);
            } else if (stored.lastCommittedHash !== this.invocationHash) {
                binding.action = 'UpdateOrCreate';
                ConsoleUtil.LogDebug(`Setting build action on stack ${stackName} for ${accountId}/${region} to ${binding.action} - hash from state did not match.`, this.logVerbose);
            } else {
                ConsoleUtil.LogDebug(`Setting build action on stack ${stackName} for ${accountId}/${region} to ${binding.action} - hash matches stored target.`, this.logVerbose);
            }
            result.push(binding);
        }

        for (const binding of result) {
            for (const dependency of binding.template.listDependencies(binding, result)) {

                binding.dependencies.push(dependency);
                binding.template.addParameter(dependency);

                const other = result.find(x => x.accountId === dependency.outputAccountId && x.region === dependency.outputRegion && x.stackName === dependency.outputStackName);
                other.dependents.push(dependency);
                other.template.addOutput(dependency);
            }
        }

        for (const storedTarget of this.state.enumTargets(this.stackName)) {
            const accountId = storedTarget.accountId;
            const region = storedTarget.region;
            const stackName = storedTarget.stackName;
            if (!targetsInTemplate.find(element => element.accountId === accountId && element.region === region && element.stackName === stackName)) {
                result.push({
                    accountId,
                    region,
                    stackName,
                    customRoleName: storedTarget.customRoleName,
                    cloudFormationRoleName: storedTarget.cloudFormationRoleName,
                    templateHash: this.invocationHash,
                    action: 'Delete',
                    state: storedTarget,
                    dependencies: [],
                    dependents: [],
                    regionDependencies: [],
                    accountDependencies: [],
                } as ICfnBinding);

                ConsoleUtil.LogDebug(`Setting build action on stack ${stackName} for ${accountId}/${region} to Delete - target found in state but not in binding.`, this.logVerbose);
             }
        }
        return result;
    }

    public enumTasks(): ICfnTask[] {
        const result: ICfnTask[] = [];
        for (const binding of this.enumBindings()) {
            if (binding.action === 'UpdateOrCreate') {
                const task = this.taskProvider.createUpdateTemplateTask(binding);
                task.isDependency = (other: ICfnTask): boolean => {
                    return binding.accountDependencies.includes(other.accountId) ||
                           binding.regionDependencies.includes(other.region) ||
                           binding.dependencies.findIndex(x => x.outputAccountId === other.accountId && x.outputRegion === other.region && x.outputStackName === other.stackName) > -1;
                };
                result.push(task);
            } else if (binding.action === 'Delete') {
                const task = this.taskProvider.createDeleteTemplateTask(binding);
                result.push(task);
            }
        }
        return result;
    }
}

export interface ICfnBinding {
    accountLogicalId: string;
    accountId: string;
    region: string;
    stackName: string;
    action: CfnBindingAction;
    target?: IResourceTarget;
    templateHash: string;
    state?: ICfnTarget;
    template?: CfnTemplate;
    dependencies: ICfnCrossAccountDependency[];
    dependents: ICfnCrossAccountDependency[];
    accountDependencies: string[];
    regionDependencies: string[];
    parameters?: Record<string, ICfnExpression>;
    terminationProtection?: boolean;
    customRoleName?: string;
    cloudFormationRoleName?: string;
    stackPolicy?: {};
}

export interface ICfnCrossAccountDependency {
    parameterAccountId: string;
    parameterRegion: string;
    parameterStackName: string;
    parameterType: string;
    parameterName: string;
    outputAccountId: string;
    outputRegion: string;
    outputStackName: string;
    outputName: string;
    outputValueExpression: ICfnExpression;
    outputCondition: string;
}

type CfnBindingAction = 'UpdateOrCreate' | 'Delete' | 'None';
