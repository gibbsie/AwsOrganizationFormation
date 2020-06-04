import { Organizations } from 'aws-sdk/clients/all';
import { AttachPolicyRequest, CreateAccountRequest, CreateOrganizationalUnitRequest, CreatePolicyRequest, DeleteOrganizationalUnitRequest, DeletePolicyRequest, DescribeCreateAccountStatusRequest, DetachPolicyRequest, EnablePolicyTypeRequest, ListAccountsForParentRequest, ListAccountsForParentResponse, ListOrganizationalUnitsForParentRequest, ListOrganizationalUnitsForParentResponse, ListPoliciesForTargetRequest, ListPoliciesForTargetResponse, MoveAccountRequest, Tag, TagResourceRequest, UntagResourceRequest, UpdateOrganizationalUnitRequest, UpdatePolicyRequest } from 'aws-sdk/clients/organizations';
import { CreateCaseRequest } from 'aws-sdk/clients/support';
import { AwsUtil, passwordPolicyEquals, DEFAULT_ROLE_FOR_CROSS_ACCOUNT_ACCESS } from '../util/aws-util';
import { ConsoleUtil } from '../util/console-util';
import { OrgFormationError } from '../org-formation-error';
import { AwsEvents } from './aws-events';
import { AwsOrganization } from './aws-organization';
import {
    AccountResource,
    OrganizationalUnitResource,
    ServiceControlPolicyResource,
} from '~parser/model';
export class AwsOrganizationWriter {

    private organization: AwsOrganization;
    private organizationService: Organizations;

    constructor(organizationService: Organizations, organization: AwsOrganization) {
        this.organizationService = organizationService;
        this.organization = organization;
    }

    public async ensureSCPEnabled(): Promise<void> {
        return await performAndRetryIfNeeded(async () => {
            const enablePolicyTypeReq: EnablePolicyTypeRequest = {
                RootId: this.organization.roots[0].Id!,
                PolicyType: 'SERVICE_CONTROL_POLICY',
            };
            try {
                await this.organizationService.enablePolicyType(enablePolicyTypeReq).promise();
                ConsoleUtil.LogDebug('enabled service control policies');
            } catch (err) {
                if (err && err.code === 'PolicyTypeAlreadyEnabledException') {
                    // do nothing
                } else {
                    throw err;
                }
            }
        });
    }

    public async createPolicy(resource: ServiceControlPolicyResource): Promise<string> {
        return await performAndRetryIfNeeded( async () => {
            try {
                const createPolicyRequest: CreatePolicyRequest = {
                    Name: resource.policyName,
                    Description: resource.description!,
                    Type: 'SERVICE_CONTROL_POLICY',
                    Content: JSON.stringify(resource.policyDocument, null, 2),
                };
                const response = await this.organizationService.createPolicy(createPolicyRequest).promise();
                const scpId = response.Policy!.PolicySummary!.Id!;
                ConsoleUtil.LogDebug(`SCP Created ${scpId}`);
                return scpId;
            } catch (err) {
                if (err.code === 'DuplicatePolicyException') {
                    const existingPolicy = this.organization.policies.find(x => x.Name === resource.policyName);
                    const scpId = existingPolicy!.Id;
                    await this.updatePolicy(resource, scpId);
                    ConsoleUtil.LogDebug(`SCP found ${scpId}`);
                    return scpId;
                }

                throw err;
            }
        });
    }

    public async attachPolicy(targetPhysicalId: string, policyPhysicalId: string): Promise<void> {
        return await performAndRetryIfNeeded( async () => {
            const attachPolicyRequest: AttachPolicyRequest = {
                PolicyId: policyPhysicalId,
                TargetId: targetPhysicalId,
            };
            try {
                try {
                    await this.ensureSCPEnabled();
                    await this.organizationService.attachPolicy(attachPolicyRequest).promise();
                } catch (err) {
                    if (err && err.code === 'PolicyTypeNotEnabledException') {
                        await this.ensureSCPEnabled();
                        await this.organizationService.attachPolicy(attachPolicyRequest).promise();
                    } else {
                        throw err;
                    }
                }
            } catch (err) {
                if (err && err.code !== 'DuplicatePolicyAttachmentException') {
                    throw err;
                }
            }
        });
    }

    public async detachPolicy(targetPhysicalId: string, policyPhysicalId: string): Promise<void> {
        return await performAndRetryIfNeeded(async () => {
            const detachPolicyRequest: DetachPolicyRequest = {
                PolicyId: policyPhysicalId,
                TargetId: targetPhysicalId,
            };
            try {
                await this.organizationService.detachPolicy(detachPolicyRequest).promise();
            } catch (err) {
                if (err && err.code !== 'PolicyNotAttachedException' && err.code !== 'PolicyNotFoundException') {
                    // 'ConcurrentModificationException' ??
                    throw err;
                }
            }
        });
    }

    public async updatePolicy(resource: ServiceControlPolicyResource, physicalId: string): Promise<void> {
        return await performAndRetryIfNeeded(async () => {
            const updatePolicyRequest: UpdatePolicyRequest = {
                PolicyId: physicalId,
                Name: resource.policyName,
                Description: resource.description,
                Content: JSON.stringify(resource.policyDocument, null, 2),
            };
            await this.organizationService.updatePolicy(updatePolicyRequest).promise();
        });
    }

    public async deletePolicy(physicalId: string): Promise<void> {
        return await performAndRetryIfNeeded(async () => {
            const deletePolicyRequest: DeletePolicyRequest = {
                PolicyId: physicalId,
            };
            try {
                await this.organizationService.deletePolicy(deletePolicyRequest).promise();
            } catch (err) {
                if (err && err.code !== 'PolicyNotFoundException' && err.code !== 'PolicyInUseException') {
                    // 'ConcurrentModificationException' ??
                    throw err;
                }
            }
        });
    }

    public async detachAccount(targetId: string, accountId: string): Promise<void> {
        await this.attachAccount(this.organization.roots[0].Id, accountId);
    }

    public async attachAccount(parentPhysicalId: string, accountPhysicalId: string): Promise<void> {
        return await performAndRetryIfNeeded(async () => {
            const account = this.organization.accounts.find(x => x.Id === accountPhysicalId);
            let parentId: string;
            if (account !== undefined) {
                parentId = account.ParentId;
            } else {
                const accountFromAws = await this.organizationService.listParents({ ChildId: accountPhysicalId }).promise();
                parentId = accountFromAws.Parents[0].Id;

            }
            if (parentId === parentPhysicalId) {
                ConsoleUtil.LogDebug(`account ${accountPhysicalId} already has parent ${parentPhysicalId}`);
                return;
            }
            const moveAccountRequest: MoveAccountRequest = {
                SourceParentId: parentId,
                DestinationParentId: parentPhysicalId,
                AccountId: accountPhysicalId,
            };

            await this.organizationService.moveAccount(moveAccountRequest).promise();

            // account will be undefined if account is suspended.
            // still needs to be moved when e.g. OU gets re-attached.
            if (account !== undefined) {
                account.ParentId = parentPhysicalId;
            }
        });
    }

    public async detachOU(targetId: string, childOuPhysicalId: string): Promise<Record<string, string>> {
        return await this.moveOU(this.organization.roots[0].Id, childOuPhysicalId);
    }

    public async moveOU(parentPhysicalId: string, childOuPhysicalId: string, mappedOUIds: Record<string, string> = {}): Promise<Record<string, string>> {
        return await performAndRetryIfNeeded(async () => {
            ConsoleUtil.LogDebug(`calling describe ou for child ${childOuPhysicalId}`);

            const childOu = await this.organizationService.describeOrganizationalUnit({ OrganizationalUnitId: childOuPhysicalId }).promise();
            const organizationalUnitName = childOu.OrganizationalUnit.Name;

            ConsoleUtil.LogDebug(`moving from OU named ${organizationalUnitName}, Id: ${childOuPhysicalId}`);

            const updateOrganizationalUnitRequest: UpdateOrganizationalUnitRequest = {
                OrganizationalUnitId: childOuPhysicalId,
                Name: organizationalUnitName + '-org-formation-move-source',
            };
            await this.organizationService.updateOrganizationalUnit(updateOrganizationalUnitRequest).promise();
            ConsoleUtil.LogDebug(`renamed OU to ${updateOrganizationalUnitRequest.Name}`);

            const createOrganizationalUnitRequest: CreateOrganizationalUnitRequest = {
                Name: organizationalUnitName,
                ParentId: parentPhysicalId,
            };
            const targetOrganizationalUnit = await this.organizationService.createOrganizationalUnit(createOrganizationalUnitRequest).promise();
            const targetOrganizationalUnitId = targetOrganizationalUnit.OrganizationalUnit.Id;

            mappedOUIds[childOuPhysicalId] = targetOrganizationalUnitId;
            ConsoleUtil.LogDebug(`created new OU named ${organizationalUnitName}, Id ${targetOrganizationalUnitId}`);

            await this._moveOuChildren(childOuPhysicalId, targetOrganizationalUnitId, mappedOUIds);
            ConsoleUtil.LogDebug(`done moving children from ${childOuPhysicalId} to ${targetOrganizationalUnitId}`);

            const deleteOrganizationalUnitRequest: DeleteOrganizationalUnitRequest = {
                OrganizationalUnitId: childOuPhysicalId,
            };

            await this.organizationService.deleteOrganizationalUnit(deleteOrganizationalUnitRequest).promise();

            try {
                const organizationalUnit = this.organization.organizationalUnits.find(x => x.Id === childOuPhysicalId);
                if (organizationalUnit === undefined) {
                    ConsoleUtil.LogWarning(`while moving OU unable to find ou with ${childOuPhysicalId} in internal model.`);
                } else {

                    organizationalUnit.Id = targetOrganizationalUnitId;

                    const oldParent = this.organization.organizationalUnits.find(x => x.OrganizationalUnits.includes(organizationalUnit));
                    if (oldParent !== undefined) {
                        oldParent.OrganizationalUnits.push(organizationalUnit);
                    }

                    const parentOrganizationalOU = this.organization.organizationalUnits.find(x => x.Id === parentPhysicalId);
                    if (parentOrganizationalOU !== undefined) {
                        parentOrganizationalOU.OrganizationalUnits.push(organizationalUnit);
                    }
                }
            } catch (err) {
                ConsoleUtil.LogWarning(`unable to update internal model. ${err}`);
            }


            return mappedOUIds;
        });
    }

    public async ensureRoot(): Promise<string> {
        const roots = this.organization.roots;
        return roots[0].Id;
    }

    public async createOrganizationalUnit(resource: OrganizationalUnitResource): Promise<string> {
        return await performAndRetryIfNeeded(async () => {
            const organizationalUnit = this.organization.organizationalUnits.find(x => x.Name === resource.organizationalUnitName);
            if (organizationalUnit) {
                ConsoleUtil.LogDebug(`ou with name ${resource.organizationalUnitName} already exists (Id: ${organizationalUnit.Id}).`);
                return organizationalUnit.Id;
            }
            const roots = this.organization.roots;
            const organizationalUnitId = await this._createOrganizationalUnit(resource, roots[0].Id);
            ConsoleUtil.LogDebug(`organizational unit ${resource.organizationalUnitName} created (Id: ${organizationalUnitId}).`);

            return organizationalUnitId;
        });
    }

    public async updateOrganizationalUnit(resource: OrganizationalUnitResource, physicalId: string): Promise<void> {
        return await performAndRetryIfNeeded(async () => {
            const updateOrganizationalUnitRequest: UpdateOrganizationalUnitRequest = {
                OrganizationalUnitId: physicalId,
                Name: resource.organizationalUnitName,
            };
            await this.organizationService.updateOrganizationalUnit(updateOrganizationalUnitRequest).promise();
        });
    }

    public async deleteOrganizationalUnit(physicalId: string): Promise<void> {
        return await performAndRetryIfNeeded(async () => {
            const existingOU = this.organization.organizationalUnits.find(x => x.Id === physicalId);
            if (existingOU === undefined) {
                ConsoleUtil.LogDebug(`can't delete organizational unit ${physicalId} not found.`);
                return;
            }
            const root = this.organization.roots[0];

            this._moveOuChildren(physicalId, root.Id, {}, true);

            const deleteOrganizationalUnitRequest: DeleteOrganizationalUnitRequest = {
                OrganizationalUnitId: physicalId,
            };
            await this.organizationService.deleteOrganizationalUnit(deleteOrganizationalUnitRequest).promise();
        });
    }

    public async createAccount(resource: AccountResource): Promise<string> {

        let accountId = resource.accountId;

        // todo and check on accountId
        const account = [...this.organization.accounts, this.organization.masterAccount].find(x => x.Id === resource.accountId || x.Email === resource.rootEmail);
        if (account !== undefined) {
            await this.updateAccount(resource, account.Id);
            ConsoleUtil.LogDebug(`account with email ${resource.rootEmail} was already part of the organization (accountId: ${account.Id}).`);
            return account.Id;
        }

        accountId = await this._createAccount(resource);

        let retryCountAccessDenied = 0;
        let shouldRetry = false;
        do {
            shouldRetry = false;
            try {
                await this.updateAccount(resource, accountId);
            } catch (err) {
                if (err.code === 'AccessDenied' && retryCountAccessDenied < 3) {
                    shouldRetry = true;
                    retryCountAccessDenied = retryCountAccessDenied + 1;
                    await sleep(3000);
                    continue;
                }
                throw err;
            }
        } while (shouldRetry);
        await AwsEvents.putAccountCreatedEvent(accountId);

        return accountId;
    }

    public async updateAccount(resource: AccountResource, accountId: string, previousResource?: AccountResource): Promise<void> {
        const account = [...this.organization.accounts, this.organization.masterAccount].find(x => x.Id === accountId);

        if (account.Name !== resource.accountName) {
            ConsoleUtil.LogWarning(`account name for ${accountId} (logicalId: ${resource.logicalId}) cannot be changed from '${account.Name}' to '${resource.accountName}'. \nInstead: login with root on the specified account to change its name`);
        }

        if (previousResource && previousResource.organizationAccessRoleName !== resource.organizationAccessRoleName) {
            ConsoleUtil.LogWarning(`When changing the organization access role for ${accountId} (logicalId: ${resource.logicalId}) the tool will not automatically rename roles in the target account. \nInstead: make sure that the name of the role in the organization model corresponds to a role in the AWS account.`);
        }

        if (account.Alias !== resource.alias) {
            const iam = await AwsUtil.GetIamService(accountId, resource.organizationAccessRoleName);
            if (account.Alias) {
                try {
                    await iam.deleteAccountAlias({ AccountAlias: account.Alias }).promise();
                } catch (err) {
                    if (err && err.code !== 'NoSuchEntity') {
                        throw err;
                    }
                }
            }
            if (resource.alias) {
                try {
                    await iam.createAccountAlias({ AccountAlias: resource.alias }).promise();
                } catch (err) {
                    if (err && err.code === 'EntityAlreadyExists') {
                        throw new OrgFormationError(`The account alias ${resource.alias} already exists. Most likely someone else already registered this alias to some other account.`);
                    }
                }
            }
        }

        if (resource.supportLevel !== undefined) {
            let currentSupportLevel = 'basic';
            if (previousResource !== undefined && previousResource.supportLevel !== undefined) {
                currentSupportLevel = previousResource.supportLevel;
            } else if (account.SupportLevel !== undefined) {
                currentSupportLevel = account.SupportLevel;
            }

            if (currentSupportLevel !== resource.supportLevel) {
                const masterAccountSupportLevel = this.organization.masterAccount.SupportLevel;
                if (masterAccountSupportLevel !== resource.supportLevel) {
                    throw new OrgFormationError(`account ${resource.logicalId} specifies support level ${resource.supportLevel}, expected is support level ${masterAccountSupportLevel}, based on the support subscription for the organization master account.`);
                } else {
                    const support = await AwsUtil.GetSupportService(this.organization.masterAccount.Id, DEFAULT_ROLE_FOR_CROSS_ACCOUNT_ACCESS.RoleName);
                    const createCaseRequest: CreateCaseRequest = {
                        subject: `Enable ${resource.supportLevel} Support for account: ${accountId}`,
                        communicationBody: `Hi AWS,
Please enable ${resource.supportLevel} on account ${accountId}.
This case was created automatically - please resolve when done.

Thank you!
                        `,
                        serviceCode: 'customer-account',
                        categoryCode: 'other-account-issues',
                        severityCode: 'low',
                        issueType: 'customer-service',
                        ccEmailAddresses: [resource.rootEmail],
                    };
                    await support.createCase(createCaseRequest).promise();
                }
            }
        }

        if (!passwordPolicyEquals(account.PasswordPolicy, resource.passwordPolicy)) {
            const iam = await AwsUtil.GetIamService(accountId, resource.organizationAccessRoleName);
            if (account.PasswordPolicy) {
                try {
                    await iam.deleteAccountPasswordPolicy().promise();
                } catch (err) {
                    if (err && err.code !== 'NoSuchEntity') {
                        throw err;
                    }
                }
            }
            if (resource.passwordPolicy && resource.passwordPolicy.TemplateResource) {
                const passwordPolicy = resource.passwordPolicy.TemplateResource;
                await iam.updateAccountPasswordPolicy({
                    MinimumPasswordLength: passwordPolicy.minimumPasswordLength,
                    RequireSymbols: passwordPolicy.requireSymbols,
                    RequireNumbers: passwordPolicy.requireNumbers,
                    RequireUppercaseCharacters: passwordPolicy.requireUppercaseCharacters,
                    RequireLowercaseCharacters: passwordPolicy.requireLowercaseCharacters,
                    MaxPasswordAge: passwordPolicy.maxPasswordAge,
                    PasswordReusePrevention: passwordPolicy.passwordReusePrevention,
                    AllowUsersToChangePassword: passwordPolicy.allowUsersToChangePassword,
                }).promise();
            }
        }

        const tagsOnResource = Object.entries(resource.tags || {});
        const keysOnResource = tagsOnResource.map(x => x[0]);
        const tagsOnAccount = Object.entries(account.Tags);
        const tagsToRemove = tagsOnAccount.map(x => x[0]).filter(x => keysOnResource.indexOf(x) === -1);
        const tagsToUpdate = keysOnResource.filter(x => resource.tags[x] !== account.Tags[x]);

        if (tagsToRemove.length > 0) {
            const request: UntagResourceRequest = {
                ResourceId: accountId,
                TagKeys: tagsToRemove,
            };
            await this.organizationService.untagResource(request).promise();
        }

        if (tagsToUpdate.length > 0) {
            const tags: Tag[] = tagsOnResource.filter(x => tagsToUpdate.indexOf(x[0]) >= 0).map(x => ({ Key: x[0], Value: (x[1] || '').toString() }));

            const request: TagResourceRequest = {
                ResourceId: accountId,
                Tags: tags,
            };
            await this.organizationService.tagResource(request).promise();
        }

        account.Tags = resource.tags;
    }

    private async _createOrganizationalUnit(resource: OrganizationalUnitResource, parentId: string): Promise<string> {
        return await performAndRetryIfNeeded(async () => {
            const createOrganizationalUnitRequest: CreateOrganizationalUnitRequest = {
                Name: resource.organizationalUnitName,
                ParentId: parentId,
            };

            const response = await this.organizationService.createOrganizationalUnit(createOrganizationalUnitRequest).promise();

            this.organization.organizationalUnits.push({
                Arn: `arn:aws:organizations::${this.organization.masterAccount.Id}:ou/${this.organization.organization.Id}/${response.OrganizationalUnit.Id}`,
                Id: response.OrganizationalUnit.Id,
                ParentId: this.organization.roots[0].Id,
                Policies: [],
                Name: resource.organizationalUnitName,
                Type: 'OrganizationalUnit',
                Accounts: [],
                OrganizationalUnits: [],
            });

            return response.OrganizationalUnit.Id;
        });
    }

    private async _createAccount(resource: AccountResource): Promise<string> {

        return await performAndRetryIfNeeded(async () => {
            const createAccountReq: CreateAccountRequest = {
                Email: resource.rootEmail,
                AccountName: resource.accountName,
            };

            if (typeof resource.organizationAccessRoleName === 'string') {
                createAccountReq.RoleName = resource.organizationAccessRoleName;
            }

            const createAccountResponse = await this.organizationService.createAccount(createAccountReq).promise();
            let accountCreationStatus = createAccountResponse.CreateAccountStatus;
            while (accountCreationStatus.State !== 'SUCCEEDED') {
                if (accountCreationStatus.State === 'FAILED') {
                    throw new OrgFormationError('creating account failed, reason: ' + accountCreationStatus.FailureReason);
                }
                const describeAccountStatusReq: DescribeCreateAccountStatusRequest = {
                    CreateAccountRequestId: createAccountResponse.CreateAccountStatus.Id,
                };
                await sleep(1000);
                const response = await this.organizationService.describeCreateAccountStatus(describeAccountStatusReq).promise();
                accountCreationStatus = response.CreateAccountStatus;
            }

            this.organization.accounts.push({
                Arn: `arn:aws:organizations::${this.organization.masterAccount.Id}:account/${this.organization.organization.Id}/${accountCreationStatus.AccountId}`,
                Id: accountCreationStatus.AccountId,
                ParentId: this.organization.roots[0].Id,
                Policies: [],
                Name: resource.accountName,
                Email: resource.rootEmail,
                Type: 'Account',
                Tags: {},
                SupportLevel: resource.supportLevel,
            });

            return accountCreationStatus.AccountId;
        });
    }

    private async _moveOuChildren(sourceId: string, targetId: string, mappedOUIds: Record<string, string>, onlyAccounts = false): Promise<void> {

        const listAccountsOfPreviousOURequest: ListAccountsForParentRequest = { ParentId: sourceId };
        let listAccountsOfPreviousOU: ListAccountsForParentResponse = {};
        do {
            listAccountsOfPreviousOU = await this.organizationService.listAccountsForParent(listAccountsOfPreviousOURequest).promise();
            for (const account of listAccountsOfPreviousOU.Accounts) {
                ConsoleUtil.LogDebug(`moving account ${account.Name} from ou ${sourceId} to ou ${targetId}`);
                await this.attachAccount(targetId, account.Id);
            }
            listAccountsOfPreviousOURequest.NextToken = listAccountsOfPreviousOURequest.NextToken;
        } while (listAccountsOfPreviousOU.NextToken);

        if (!onlyAccounts) {

            const listServiceControlPoliciesOfPreviousOURequest: ListPoliciesForTargetRequest = { TargetId: sourceId, Filter: 'SERVICE_CONTROL_POLICY' };
            let listServiceControlPoliciesOfPreviousOU: ListPoliciesForTargetResponse = {};
            do {
                listServiceControlPoliciesOfPreviousOU = await this.organizationService.listPoliciesForTarget(listServiceControlPoliciesOfPreviousOURequest).promise();
                for (const scp of listServiceControlPoliciesOfPreviousOU.Policies) {
                    ConsoleUtil.LogDebug(`moving scp from ou ${sourceId} to ou ${targetId}`);
                    const attachPromise = this.organizationService.attachPolicy({ PolicyId: scp.Id, TargetId: targetId });
                    const detachPromise = this.organizationService.detachPolicy({ PolicyId: scp.Id, TargetId: sourceId });
                    await Promise.all([attachPromise, detachPromise]);
                }
            } while (listServiceControlPoliciesOfPreviousOU.NextToken);

            const listChildUnitsOfPreviousOURequest: ListOrganizationalUnitsForParentRequest = { ParentId: sourceId };
            let childUnitsOfPreviousOU: ListOrganizationalUnitsForParentResponse = await this.organizationService.listOrganizationalUnitsForParent(listChildUnitsOfPreviousOURequest).promise();
            do {
                childUnitsOfPreviousOU = await this.organizationService.listOrganizationalUnitsForParent(listChildUnitsOfPreviousOURequest).promise();
                for (const child of childUnitsOfPreviousOU.OrganizationalUnits) {
                    ConsoleUtil.LogDebug(`moving child ou from ou ${sourceId} to ou ${targetId}`);
                    await this.moveOU(targetId, child.Id, mappedOUIds);
                }
            } while (childUnitsOfPreviousOU.NextToken);

        }

    }
}

const performAndRetryIfNeeded = async <T extends unknown>(fn: () => Promise<T>): Promise<T> => {
    let shouldRetry = false;
    let retryCount = 0;
    do {
        shouldRetry = false;
        try {
            return await fn();
        } catch (err) {
            if (err && (err.code === 'ConcurrentModificationException' || err.code === 'TooManyRequestsException') && retryCount < 3) {
                retryCount = retryCount + 1;
                shouldRetry = true;
                const wait = Math.pow(retryCount, 2) + Math.random();
                ConsoleUtil.LogDebug(`received retryable error ${err.code}. wait ${wait} and retry-count ${retryCount}`);
                await sleep(wait * 1000);
                continue;
            }
            throw err;
        }
    }
    while (shouldRetry);
};

const sleep = (time: number): Promise<void> => {
    return new Promise(resolve => setTimeout(resolve, time));
};
