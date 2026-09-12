export function getDefaultUploadOrganizationId(
	organizations: readonly { id: string }[],
	userId: string | undefined,
): string | undefined {
	const personal = organizations.find(
		(organization) => organization.id === userId,
	);
	return (
		personal?.id ??
		(organizations.length === 1 ? organizations[0]?.id : undefined)
	);
}
