export function checkMtsLeadStatuses(page: unknown, phone: string): Promise<string[]>;
export function checkMtsContractList(
  page: unknown,
  phone: string
): Promise<Array<{ custNumber: string; name: string; medium: string; status: string; saleDate: string }>>;
