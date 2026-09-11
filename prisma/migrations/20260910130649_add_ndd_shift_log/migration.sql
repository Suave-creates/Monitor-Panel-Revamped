-- CreateTable
CREATE TABLE `ndd_shift_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `day` DATE NOT NULL,
    `hour` TINYINT NOT NULL,
    `facility` VARCHAR(8) NOT NULL,
    `dept` VARCHAR(32) NOT NULL,
    `cols` JSON NOT NULL,
    `hist` JSON NOT NULL,
    `rowTotal` INTEGER NOT NULL,
    `capturedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ndd_shift_logs_day_idx`(`day`),
    UNIQUE INDEX `ndd_shift_logs_day_hour_facility_dept_key`(`day`, `hour`, `facility`, `dept`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
