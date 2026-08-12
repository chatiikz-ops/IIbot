import { IsInt, IsString, Matches, Max, Min } from 'class-validator';

export class CampaignSettingsDto {
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  workingHoursStart!: string;

  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  workingHoursEnd!: string;

  @IsInt()
  @Min(1)
  @Max(100_000)
  dailyMessageLimit!: number;

  @IsInt()
  @Min(0)
  @Max(86_400)
  minDelaySeconds!: number;

  @IsInt()
  @Min(0)
  @Max(86_400)
  maxDelaySeconds!: number;

  @IsString()
  @Matches(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/)
  timezone!: string;
}
